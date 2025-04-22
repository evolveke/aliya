require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const winston = require('winston');
const pool = require('./db');
const schedule = require('node-schedule');
const { analyzeSymptoms, analyzeHealthAssessment, generateFitnessPlan, generateMealPlan, answerHealthQuestion } = require('./cohere');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/app.log' }),
    new winston.transports.Console()
  ]
});

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    args: ['--no-sandbox', '--disable-setuid-sandbox'], // Add these args to disable sandboxing
    headless: true // Ensure headless mode for Railway
  }
});

const userStates = new Map();

const INTRODUCTION_MESSAGE = `
Hello! I'm Aliya, your health assistant on WhatsApp. I can help with symptom analysis, health assessments, fitness and meal plans, menstrual cycle tracking, medication reminders, and general health questions.

⚠️ *Disclaimer*: I am not a doctor. My advice is for informational purposes only and should not replace professional medical advice.

📋 *Terms and Conditions*:
- I will collect and store your personal and health data (e.g., name, age, medical history) to provide personalized services.
- Your data will be stored securely in a database and used only for health-related features.
- You can stop using my services at any time, and your data will be handled per our privacy policy.

Please reply with *accept* to agree to the terms and start onboarding, or *deny* to exit.
`;

const HELP_MESSAGE = `
*Aliya Health Assistant - Available Commands*

/start - Begin the onboarding process (if not already completed)
/diagnose - Analyze symptoms and get potential conditions (after onboarding)
/assessment - Take a health assessment test (after onboarding)
/fitness - Get a personalized fitness plan (after onboarding)
/meal - Get a personalized meal plan (after onboarding)
/cycle - Track or update your menstrual cycle (after onboarding, for applicable users)
/medication - Set or update medication reminders (after onboarding)
/ask - Ask general health-related questions (after onboarding)
/help - Show this help menu
/cancel - Cancel the current operation (e.g., onboarding, diagnosis)
`;

const ONBOARDING_STEPS = [
  { field: 'name', prompt: 'Please provide your name.', validate: (input) => input.trim() !== '' ? null : 'Name cannot be empty.' },
  { field: 'age', prompt: 'Please provide your age (e.g., 25).', validate: (input) => {
      const age = parseInt(input);
      return isNaN(age) || age < 1 || age > 120 ? 'Please provide a valid age (1-120).' : null;
    }
  },
  { field: 'sex', prompt: 'Please provide your sex (male, female, other).', validate: (input) => {
      const valid = ['male', 'female', 'other'].includes(input.toLowerCase());
      return valid ? null : 'Please provide male, female, or other.';
    }
  },
  { field: 'height_cm', prompt: 'Please provide your height in centimeters (e.g., 170).', validate: (input) => {
      const height = parseInt(input);
      return isNaN(height) || height < 50 || height > 300 ? 'Please provide a valid height (50-300 cm).' : null;
    }
  },
  { field: 'weight_kg', prompt: 'Please provide your weight in kilograms (e.g., 70).', validate: (input) => {
      const weight = parseInt(input);
      return isNaN(weight) || weight < 20 || weight > 500 ? 'Please provide a valid weight (20-500 kg).' : null;
    }
  },
  { field: 'location', prompt: 'Please provide your location (e.g., New York).', validate: (input) => input.trim() !== '' ? null : 'Location cannot be empty.' },
  { field: 'medical_history', prompt: 'Please provide a brief medical history (or type "none").', validate: () => null },
  { field: 'chronic_conditions', prompt: 'Please list any chronic conditions (or type "none").', validate: () => null },
  { field: 'allergies', prompt: 'Please list any allergies (or type "none").', validate: () => null },
  { field: 'medications', prompt: 'Please list any current medications (or type "none").', validate: () => null }
];

const MENSTRUAL_CYCLE_STEP = {
  field: 'menstrual_cycle_type',
  prompt: 'Please specify your menstrual cycle type (regular, irregular, or none).',
  validate: (input) => {
    const valid = ['regular', 'irregular', 'none'].includes(input.toLowerCase());
    return valid ? null : 'Please provide regular, irregular, or none.';
  }
};

const DIAGNOSIS_STEPS = [
  { field: 'symptoms', prompt: 'Please describe your symptoms (e.g., fever, cough).', validate: (input) => input.trim() !== '' ? null : 'Symptoms cannot be empty.' },
  { field: 'severity', prompt: 'How severe are your symptoms? (mild, moderate, severe)', validate: (input) => {
      const valid = ['mild', 'moderate', 'severe'].includes(input.toLowerCase());
      return valid ? null : 'Please provide mild, moderate, or severe.';
    }
  },
  { field: 'duration', prompt: 'How long have you had these symptoms? (e.g., 2 days, 1 week)', validate: (input) => input.trim() !== '' ? null : 'Duration cannot be empty.' }
];

const ASSESSMENT_STEPS = [
  { field: 'overall_health', prompt: 'How would you rate your overall health? (excellent, good, fair, poor)', validate: (input) => {
      const valid = ['excellent', 'good', 'fair', 'poor'].includes(input.toLowerCase());
      return valid ? null : 'Please provide excellent, good, fair, or poor.';
    }
  },
  { field: 'fatigue_after_sleep', prompt: 'Do you often feel fatigued even after adequate sleep? (often, sometimes, rarely, never)', validate: (input) => {
      const valid = ['often', 'sometimes', 'rarely', 'never'].includes(input.toLowerCase());
      return valid ? null : 'Please provide often, sometimes, rarely, or never.';
    }
  },
  { field: 'fruit_veggie_servings', prompt: 'How many servings of fruits/vegetables do you eat daily? (e.g., 3)', validate: (input) => {
      const servings = parseInt(input);
      return isNaN(servings) || servings < 0 || servings > 20 ? 'Please provide a valid number (0-20).' : null;
    }
  },
  { field: 'sugary_drinks_snacks', prompt: 'Do you consume sugary drinks or snacks daily? (yes, no)', validate: (input) => {
      const valid = ['yes', 'no'].includes(input.toLowerCase());
      return valid ? null : 'Please provide yes or no.';
    }
  },
  { field: 'exercise_days', prompt: 'How many days per week do you exercise ≥30 minutes? (0-7)', validate: (input) => {
      const days = parseInt(input);
      return isNaN(days) || days < 0 || days > 7 ? 'Please provide a valid number (0-7).' : null;
    }
  },
  { field: 'breaks_from_sitting', prompt: 'Do you take breaks from sitting every hour? (yes, no)', validate: (input) => {
      const valid = ['yes', 'no'].includes(input.toLowerCase());
      return valid ? null : 'Please provide yes or no.';
    }
  },
  { field: 'sleep_hours', prompt: 'On average, how many hours do you sleep per night? (e.g., 7)', validate: (input) => {
      const hours = parseInt(input);
      return isNaN(hours) || hours < 0 || hours > 24 ? 'Please provide a valid number (0-24).' : null;
    }
  },
  { field: 'wake_refreshed', prompt: 'Do you wake up feeling refreshed most mornings? (often, sometimes, rarely, never)', validate: (input) => {
      const valid = ['often', 'sometimes', 'rarely', 'never'].includes(input.toLowerCase());
      return valid ? null : 'Please provide often, sometimes, rarely, or never.';
    }
  },
  { field: 'stress_anxiety', prompt: 'How often do you feel stressed or anxious? (often, sometimes, rarely, never)', validate: (input) => {
      const valid = ['often', 'sometimes', 'rarely', 'never'].includes(input.toLowerCase());
      return valid ? null : 'Please provide often, sometimes, rarely, or never.';
    }
  },
  { field: 'relaxation_techniques', prompt: 'Do you practice relaxation techniques? (yes, no)', validate: (input) => {
      const valid = ['yes', 'no'].includes(input.toLowerCase());
      return valid ? null : 'Please provide yes or no.';
    }
  },
  { field: 'chronic_conditions', prompt: 'Do you have any diagnosed chronic conditions? (yes, no)', validate: (input) => {
      const valid = ['yes', 'no'].includes(input.toLowerCase());
      return valid ? null : 'Please provide yes or no.';
    }
  },
  { field: 'family_history', prompt: 'Is there a family history of heart disease or diabetes? (yes, no)', validate: (input) => {
      const valid = ['yes', 'no'].includes(input.toLowerCase());
      return valid ? null : 'Please provide yes or no.';
    }
  },
  { field: 'smoking_vaping', prompt: 'Do you smoke or vape? (yes, no)', validate: (input) => {
      const valid = ['yes', 'no'].includes(input.toLowerCase());
      return valid ? null : 'Please provide yes or no.';
    }
  },
  { field: 'alcohol_drinks', prompt: 'How many alcoholic drinks do you have weekly? (e.g., 2)', validate: (input) => {
      const drinks = parseInt(input);
      return isNaN(drinks) || drinks < 0 || drinks > 100 ? 'Please provide a valid number (0-100).' : null;
    }
  },
  { field: 'headaches_body_aches', prompt: 'Do you experience frequent headaches or body aches? (often, sometimes, rarely, never)', validate: (input) => {
      const valid = ['often', 'sometimes', 'rarely', 'never'].includes(input.toLowerCase());
      return valid ? null : 'Please provide often, sometimes, rarely, or never.';
    }
  },
  { field: 'weight_changes', prompt: 'Have you had unexplained weight changes in the past year? (yes, no)', validate: (input) => {
      const valid = ['yes', 'no'].includes(input.toLowerCase());
      return valid ? null : 'Please provide yes or no.';
    }
  }
];

const FITNESS_STEPS = [
  { field: 'fitness_goal', prompt: 'What is your fitness goal? (e.g., weight loss, muscle gain, general fitness)', validate: (input) => {
      const valid = ['weight loss', 'muscle gain', 'general fitness'].includes(input.toLowerCase());
      return valid ? null : 'Please provide weight loss, muscle gain, or general fitness.';
    }
  },
  { field: 'activity_level', prompt: 'What is your current activity level? (beginner, intermediate, advanced)', validate: (input) => {
      const valid = ['beginner', 'intermediate', 'advanced'].includes(input.toLowerCase());
      return valid ? null : 'Please provide beginner, intermediate, or advanced.';
    }
  },
  { field: 'available_days', prompt: 'How many days per week can you exercise? (0-7)', validate: (input) => {
      const days = parseInt(input);
      return isNaN(days) || days < 0 || days > 7 ? 'Please provide a valid number (0-7).' : null;
    }
  },
  { field: 'available_minutes', prompt: 'How many minutes can you exercise per session? (e.g., 30)', validate: (input) => {
      const minutes = parseInt(input);
      return isNaN(minutes) || minutes < 10 || minutes > 180 ? 'Please provide a valid number (10-180 minutes).' : null;
    }
  }
];

const MEAL_STEPS = [
  { field: 'dietary_preference', prompt: 'What is your dietary preference? (e.g., vegetarian, vegan, omnivore)', validate: (input) => {
      const valid = ['vegetarian', 'vegan', 'omnivore'].includes(input.toLowerCase());
      return valid ? null : 'Please provide vegetarian, vegan, or omnivore.';
    }
  },
  { field: 'health_goal', prompt: 'What is your health goal? (e.g., weight loss, muscle gain, general health)', validate: (input) => {
      const valid = ['weight loss', 'muscle gain', 'general health'].includes(input.toLowerCase());
      return valid ? null : 'Please provide weight loss, muscle gain, or general health.';
    }
  },
  { field: 'meals_per_day', prompt: 'How many meals do you want per day? (2-5)', validate: (input) => {
      const meals = parseInt(input);
      return isNaN(meals) || meals < 2 || meals > 5 ? 'Please provide a valid number (2-5).' : null;
    }
  }
];

const CYCLE_STEPS = [
  { field: 'last_period_date', prompt: 'When did your last period start? (e.g., YYYY-MM-DD, like 2025-04-01)', validate: (input) => {
      const date = new Date(input);
      const today = new Date();
      return isNaN(date) || date > today ? 'Please provide a valid past date in YYYY-MM-DD format.' : null;
    }
  },
  { field: 'average_cycle_length', prompt: 'What is your average cycle length in days? (e.g., 28, typically 21-35)', validate: (input) => {
      const length = parseInt(input);
      return isNaN(length) || length < 21 || length > 35 ? 'Please provide a valid number (21-35 days).' : null;
    }
  }
];

const MEDICATION_STEPS = [
  { field: 'medication_name', prompt: 'What is the name of the medication? (e.g., Ibuprofen)', validate: (input) => input.trim() !== '' ? null : 'Medication name cannot be empty.' },
  { field: 'dosage', prompt: 'What is the dosage? (e.g., 200 mg, 1 tablet)', validate: (input) => input.trim() !== '' ? null : 'Dosage cannot be empty.' },
  { field: 'schedule_time', prompt: 'What time should I remind you to take it? (e.g., 08:00, in 24-hour format)', validate: (input) => {
      const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
      return timeRegex.test(input) ? null : 'Please provide a valid time in HH:MM format (e.g., 08:00).';
    }
  },
  { field: 'days_of_week', prompt: 'Which days should I remind you? (e.g., Daily or Mon,Wed,Fri)', validate: (input) => {
      if (input.toLowerCase() === 'daily') return null;
      const days = input.split(',').map(d => d.trim());
      const validDays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
      const isValid = days.every(day => validDays.includes(day.toLowerCase()));
      return isValid ? null : 'Please provide "Daily" or days like Mon,Wed,Fri.';
    }
  }
];

async function testDatabase() {
  try {
    const res = await pool.query('SELECT NOW()');
    logger.info('Database test query successful: ' + res.rows[0].now);
  } catch (err) {
    logger.error('Database test query failed: ' + err.stack);
    throw new Error('Database connection failed');
  }
}

async function isUserOnboarded(whatsappId) {
  try {
    const res = await pool.query('SELECT id FROM users WHERE whatsapp_id = $1', [whatsappId]);
    return res.rows.length > 0;
  } catch (err) {
    logger.error(`Error checking user onboarding status for ${whatsappId}: ${err.stack}`);
    throw new Error('Failed to check onboarding status');
  }
}

async function getUserDetails(whatsappId) {
  try {
    const res = await pool.query('SELECT id, sex, menstrual_cycle_type FROM users WHERE whatsapp_id = $1', [whatsappId]);
    return res.rows.length > 0 ? res.rows[0] : null;
  } catch (err) {
    logger.error(`Error fetching user details for ${whatsappId}: ${err.stack}`);
    throw new Error('Failed to fetch user details');
  }
}

async function saveUserProfile(whatsappId, data) {
  try {
    const query = `
      INSERT INTO users (
        whatsapp_id, name, age, sex, height_cm, weight_kg, location,
        medical_history, chronic_conditions, allergies, medications, menstrual_cycle_type
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING id
    `;
    const values = [
      whatsappId,
      data.name,
      data.age,
      data.sex,
      data.height_cm,
      data.weight_kg,
      data.location,
      data.medical_history,
      data.chronic_conditions,
      data.allergies,
      data.medications,
      data.menstrual_cycle_type || null
    ];
    const res = await pool.query(query, values);
    logger.info(`User ${whatsappId} profile saved with ID ${res.rows[0].id}`);
    return true;
  } catch (err) {
    logger.error(`Error saving user profile for ${whatsappId}: ${err.stack}`);
    throw new Error('Failed to save user profile');
  }
}

async function saveDiagnosis(userId, data) {
  try {
    const userRes = await pool.query('SELECT id FROM users WHERE whatsapp_id = $1', [userId]);
    if (userRes.rows.length === 0) {
      logger.error(`User ${userId} not found in database`);
      return false;
    }
    const userDbId = userRes.rows[0].id;
    const query = `
      INSERT INTO symptoms (
        user_id, symptoms, severity, duration, diagnosis, home_care, red_flags
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
    `;
    const values = [
      userDbId,
      data.symptoms,
      data.severity,
      data.duration,
      data.diagnosis || null,
      data.home_care || null,
      data.red_flags || null
    ];
    const res = await pool.query(query, values);
    logger.info(`Diagnosis saved for user ${userId} with ID ${res.rows[0].id}`);
    return true;
  } catch (err) {
    logger.error(`Error saving diagnosis for ${userId}: ${err.stack}`);
    throw new Error('Failed to save diagnosis');
  }
}

async function saveAssessment(userId, data) {
  try {
    const userRes = await pool.query('SELECT id FROM users WHERE whatsapp_id = $1', [userId]);
    if (userRes.rows.length === 0) {
      logger.error(`User ${userId} not found in database`);
      return false;
    }
    const userDbId = userRes.rows[0].id;
    const query = `
      INSERT INTO assessments (
        user_id, overall_health, fatigue_after_sleep, fruit_veggie_servings,
        sugary_drinks_snacks, exercise_days, breaks_from_sitting, sleep_hours,
        wake_refreshed, stress_anxiety, relaxation_techniques, chronic_conditions,
        family_history, smoking_vaping, alcohol_drinks, headaches_body_aches,
        weight_changes, score, analysis, recommendations
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
      RETURNING id
    `;
    const values = [
      userDbId,
      data.overall_health,
      data.fatigue_after_sleep,
      data.fruit_veggie_servings,
      data.sugary_drinks_snacks,
      data.exercise_days,
      data.breaks_from_sitting,
      data.sleep_hours,
      data.wake_refreshed,
      data.stress_anxiety,
      data.relaxation_techniques,
      data.chronic_conditions,
      data.family_history,
      data.smoking_vaping,
      data.alcohol_drinks,
      data.headaches_body_aches,
      data.weight_changes,
      data.score,
      data.analysis || null,
      data.recommendations || null
    ];
    const res = await pool.query(query, values);
    logger.info(`Assessment saved for user ${userId} with ID ${res.rows[0].id}`);
    return true;
  } catch (err) {
    logger.error(`Error saving assessment for ${userId}: ${err.stack}`);
    throw new Error('Failed to save assessment');
  }
}

async function saveFitnessPlan(userId, data) {
  try {
    const userRes = await pool.query('SELECT id FROM users WHERE whatsapp_id = $1', [userId]);
    if (userRes.rows.length === 0) {
      logger.error(`User ${userId} not found in database`);
      return false;
    }
    const userDbId = userRes.rows[0].id;
    const query = `
      INSERT INTO fitness_plans (
        user_id, fitness_goal, activity_level, available_days, available_minutes, fitness_plan
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `;
    const values = [
      userDbId,
      data.fitness_goal,
      data.activity_level,
      data.available_days,
      data.available_minutes,
      data.fitness_plan || null
    ];
    const res = await pool.query(query, values);
    logger.info(`Fitness plan saved for user ${userId} with ID ${res.rows[0].id}`);
    return true;
  } catch (err) {
    logger.error(`Error saving fitness plan for ${userId}: ${err.stack}`);
    throw new Error('Failed to save fitness plan');
  }
}

async function saveMealPlan(userId, data) {
  try {
    const userRes = await pool.query('SELECT id FROM users WHERE whatsapp_id = $1', [userId]);
    if (userRes.rows.length === 0) {
      logger.error(`User ${userId} not found in database`);
      return false;
    }
    const userDbId = userRes.rows[0].id;
    const query = `
      INSERT INTO meal_plans (
        user_id, dietary_preference, health_goal, meals_per_day, meal_plan
      ) VALUES ($1, $2, $3, $4, $5)
      RETURNING id
    `;
    const values = [
      userDbId,
      data.dietary_preference,
      data.health_goal,
      data.meals_per_day,
      data.meal_plan || null
    ];
    const res = await pool.query(query, values);
    logger.info(`Meal plan saved for user ${userId} with ID ${res.rows[0].id}`);
    return true;
  } catch (err) {
    logger.error(`Error saving meal plan for ${userId}: ${err.stack}`);
    throw new Error('Failed to save meal plan');
  }
}

async function saveMenstrualCycle(userId, data) {
  try {
    const userRes = await pool.query('SELECT id FROM users WHERE whatsapp_id = $1', [userId]);
    if (userRes.rows.length === 0) {
      logger.error(`User ${userId} not found in database`);
      return false;
    }
    const userDbId = userRes.rows[0].id;

    const existingRecord = await pool.query('SELECT id FROM menstrual_cycles WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [userDbId]);
    
    if (existingRecord.rows.length > 0) {
      const query = `
        UPDATE menstrual_cycles
        SET last_period_date = $1, average_cycle_length = $2, predicted_next_period = $3, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = $4
        RETURNING id
      `;
      const values = [
        data.last_period_date,
        data.average_cycle_length,
        data.predicted_next_period,
        userDbId
      ];
      const res = await pool.query(query, values);
      logger.info(`Updated menstrual cycle for user ${userId} with ID ${res.rows[0].id}`);
      return true;
    } else {
      const query = `
        INSERT INTO menstrual_cycles (
          user_id, last_period_date, average_cycle_length, predicted_next_period
        ) VALUES ($1, $2, $3, $4)
        RETURNING id
      `;
      const values = [
        userDbId,
        data.last_period_date,
        data.average_cycle_length,
        data.predicted_next_period
      ];
      const res = await pool.query(query, values);
      logger.info(`Saved menstrual cycle for user ${userId} with ID ${res.rows[0].id}`);
      return true;
    }
  } catch (err) {
    logger.error(`Error saving menstrual cycle for ${userId}: ${err.stack}`);
    throw new Error('Failed to save menstrual cycle data');
  }
}

async function saveMedicationReminder(userId, data) {
  try {
    const userRes = await pool.query('SELECT id FROM users WHERE whatsapp_id = $1', [userId]);
    if (userRes.rows.length === 0) {
      logger.error(`User ${userId} not found in database`);
      return false;
    }
    const userDbId = userRes.rows[0].id;

    const existingRecord = await pool.query('SELECT id FROM medication_reminders WHERE user_id = $1 AND medication_name = $2', [userDbId, data.medication_name]);
    
    if (existingRecord.rows.length > 0) {
      const query = `
        UPDATE medication_reminders
        SET dosage = $1, schedule_time = $2, days_of_week = $3, created_at = CURRENT_TIMESTAMP
        WHERE user_id = $4 AND medication_name = $5
        RETURNING id
      `;
      const values = [
        data.dosage,
        data.schedule_time,
        data.days_of_week,
        userDbId,
        data.medication_name
      ];
      const res = await pool.query(query, values);
      logger.info(`Updated medication reminder for user ${userId} with ID ${res.rows[0].id}`);
      return true;
    } else {
      const query = `
        INSERT INTO medication_reminders (
          user_id, medication_name, dosage, schedule_time, days_of_week
        ) VALUES ($1, $2, $3, $4, $5)
        RETURNING id
      `;
      const values = [
        userDbId,
        data.medication_name,
        data.dosage,
        data.schedule_time,
        data.days_of_week
      ];
      const res = await pool.query(query, values);
      logger.info(`Saved medication reminder for user ${userId} with ID ${res.rows[0].id}`);
      return true;
    }
  } catch (err) {
    logger.error(`Error saving medication reminder for ${userId}: ${err.stack}`);
    throw new Error('Failed to save medication reminder');
  }
}

async function getMenstrualCycle(userId) {
  try {
    const userRes = await pool.query('SELECT id FROM users WHERE whatsapp_id = $1', [userId]);
    if (userRes.rows.length === 0) {
      logger.error(`User ${userId} not found in database`);
      return null;
    }
    const userDbId = userRes.rows[0].id;
    const res = await pool.query('SELECT * FROM menstrual_cycles WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [userDbId]);
    return res.rows.length > 0 ? res.rows[0] : null;
  } catch (err) {
    logger.error(`Error fetching menstrual cycle for ${userId}: ${err.stack}`);
    throw new Error('Failed to fetch menstrual cycle data');
  }
}

async function getMedicationReminders(userId) {
  try {
    const userRes = await pool.query('SELECT id FROM users WHERE whatsapp_id = $1', [userId]);
    if (userRes.rows.length === 0) {
      logger.error(`User ${userId} not found in database`);
      return null;
    }
    const userDbId = userRes.rows[0].id;
    const res = await pool.query('SELECT * FROM medication_reminders WHERE user_id = $1', [userDbId]);
    return res.rows;
  } catch (err) {
    logger.error(`Error fetching medication reminders for ${userId}: ${err.stack}`);
    throw new Error('Failed to fetch medication reminders');
  }
}

async function getLatestFitnessPlan(userId) {
  try {
    const userRes = await pool.query('SELECT id FROM users WHERE whatsapp_id = $1', [userId]);
    if (userRes.rows.length === 0) {
      logger.error(`User ${userId} not found in database`);
      return null;
    }
    const userDbId = userRes.rows[0].id;
    const res = await pool.query('SELECT * FROM fitness_plans WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [userDbId]);
    return res.rows.length > 0 ? res.rows[0] : null;
  } catch (err) {
    logger.error(`Error fetching fitness plan for ${userId}: ${err.stack}`);
    throw new Error('Failed to fetch fitness plan');
  }
}

async function getLatestMealPlan(userId) {
  try {
    const userRes = await pool.query('SELECT id FROM users WHERE whatsapp_id = $1', [userId]);
    if (userRes.rows.length === 0) {
      logger.error(`User ${userId} not found in database`);
      return null;
    }
    const userDbId = userRes.rows[0].id;
    const res = await pool.query('SELECT * FROM meal_plans WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [userDbId]);
    return res.rows.length > 0 ? res.rows[0] : null;
  } catch (err) {
    logger.error(`Error fetching meal plan for ${userId}: ${err.stack}`);
    throw new Error('Failed to fetch meal plan');
  }
}

function calculateNextPeriod(lastPeriodDate, cycleLength) {
  const lastDate = new Date(lastPeriodDate);
  const nextDate = new Date(lastDate);
  nextDate.setDate(lastDate.getDate() + parseInt(cycleLength));
  return nextDate.toISOString().split('T')[0];
}

function schedulePeriodReminder(userId, predictedDate) {
  const reminderDate = new Date(predictedDate);
  reminderDate.setDate(reminderDate.getDate() - 3);
  const now = new Date();

  if (reminderDate < now) {
    logger.info(`Reminder date ${reminderDate} for user ${userId} is in the past, skipping scheduling`);
    return;
  }

  schedule.scheduleJob(reminderDate, async () => {
    try {
      await client.sendMessage(userId, `Reminder: Your next period is predicted to start on ${predictedDate}. Prepare accordingly! Reply with /cycle to update your details.`);
      logger.info(`Sent period reminder to ${userId} for ${predictedDate}`);
    } catch (err) {
      logger.error(`Error sending period reminder to ${userId}: ${err.message}`);
    }
  });
  logger.info(`Scheduled period reminder for ${userId} on ${reminderDate} for period on ${predictedDate}`);
}

function scheduleMedicationReminder(userId, data) {
  const { medication_name, dosage, schedule_time, days_of_week } = data;
  const [hour, minute] = schedule_time.split(':').map(Number);
  const days = days_of_week.toLowerCase() === 'daily' 
    ? '*'
    : days_of_week.split(',').map(day => {
        const dayMap = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0 };
        return dayMap[day.toLowerCase()];
      }).join(',');

  const rule = days === '*' 
    ? { hour, minute }
    : `${minute} ${hour} * * ${days}`;

  schedule.scheduleJob(rule, async () => {
    try {
      await client.sendMessage(userId, `Reminder: Time to take your ${medication_name} (${dosage})!`);
      logger.info(`Sent medication reminder to ${userId} for ${medication_name} at ${schedule_time}`);
    } catch (err) {
      logger.error(`Error sending medication reminder to ${userId}: ${err.message}`);
    }
  });
  logger.info(`Scheduled medication reminder for ${userId} - ${medication_name} at ${schedule_time} on ${days_of_week}`);
}

function scheduleFitnessReminder(userId) {
  const rule = { hour: 7, minute: 0 }; // Daily at 7:00 AM
  schedule.scheduleJob(rule, async () => {
    try {
      const fitnessPlan = await getLatestFitnessPlan(userId);
      if (fitnessPlan) {
        await client.sendMessage(userId, `Reminder: Follow your fitness plan today! Goal: ${fitnessPlan.fitness_goal}. Use /fitness to view or update your plan.`);
        logger.info(`Sent fitness reminder to ${userId}`);
      }
    } catch (err) {
      logger.error(`Error sending fitness reminder to ${userId}: ${err.message}`);
    }
  });
  logger.info(`Scheduled daily fitness reminder for ${userId} at 07:00`);
}

function scheduleMealReminder(userId) {
  const rule = { hour: 8, minute: 0 }; // Daily at 8:00 AM
  schedule.scheduleJob(rule, async () => {
    try {
      const mealPlan = await getLatestMealPlan(userId);
      if (mealPlan) {
        await client.sendMessage(userId, `Reminder: Follow your meal plan today! Preference: ${mealPlan.dietary_preference}, Goal: ${mealPlan.health_goal}. Use /meal to view or update your plan.`);
        logger.info(`Sent meal reminder to ${userId}`);
      }
    } catch (err) {
      logger.error(`Error sending meal reminder to ${userId}: ${err.message}`);
    }
  });
  logger.info(`Scheduled daily meal reminder for ${userId} at 08:00`);
}

function scheduleAssessmentReminder(userId) {
  const reminderDate = new Date();
  reminderDate.setHours(reminderDate.getHours() + 48);
  schedule.scheduleJob(reminderDate, async () => {
    try {
      await client.sendMessage(userId, 'Reminder: Would you like to take your health assessment test now? Reply with /assessment to start.');
      logger.info(`Sent assessment reminder to ${userId}`);
    } catch (err) {
      logger.error(`Error sending assessment reminder to ${userId}: ${err.message}`);
    }
  });
  logger.info(`Scheduled assessment reminder for ${userId} on ${reminderDate}`);
}

function scheduleFollowUpReminder(userId, severity) {
  if (severity.toLowerCase() !== 'severe') return;
  const reminderDate = new Date();
  reminderDate.setDate(reminderDate.getDate() + 2);
  schedule.scheduleJob(reminderDate, async () => {
    try {
      await client.sendMessage(userId, 'Follow-up: How are your symptoms now? Reply with /diagnose to update or consult a doctor if symptoms persist.');
      logger.info(`Sent follow-up reminder to ${userId}`);
    } catch (err) {
      logger.error(`Error sending follow-up reminder to ${userId}: ${err.message}`);
    }
  });
  logger.info(`Scheduled follow-up reminder for ${userId} on ${reminderDate}`);
}

function calculateHealthScore(data) {
  let score = 0;
  switch (data.overall_health.toLowerCase()) {
    case 'excellent': score += 10; break;
    case 'good': score += 7; break;
    case 'fair': score += 4; break;
  }
  switch (data.fatigue_after_sleep.toLowerCase()) {
    case 'never': score += 6; break;
    case 'rarely': score += 4; break;
    case 'sometimes': score += 2; break;
  }
  const servings = parseInt(data.fruit_veggie_servings);
  if (servings >= 5) score += 8;
  else if (servings >= 3) score += 5;
  else if (servings >= 1) score += 2;
  if (data.sugary_drinks_snacks.toLowerCase() === 'no') score += 6;
  const exerciseDays = parseInt(data.exercise_days);
  if (exerciseDays >= 5) score += 8;
  else if (exerciseDays >= 3) score += 5;
  else if (exerciseDays >= 1) score += 2;
  if (data.breaks_from_sitting.toLowerCase() === 'yes') score += 6;
  const sleepHours = parseInt(data.sleep_hours);
  if (sleepHours >= 7 && sleepHours <= 9) score += 8;
  else if (sleepHours >= 5 && sleepHours < 7 || sleepHours > 9 && sleepHours <= 11) score += 4;
  switch (data.wake_refreshed.toLowerCase()) {
    case 'often': score += 6; break;
    case 'sometimes': score += 4; break;
    case 'rarely': score += 2; break;
  }
  switch (data.stress_anxiety.toLowerCase()) {
    case 'never': score += 6; break;
    case 'rarely': score += 4; break;
    case 'sometimes': score += 2; break;
  }
  if (data.relaxation_techniques.toLowerCase() === 'yes') score += 6;
  if (data.chronic_conditions.toLowerCase() === 'no') score += 6;
  if (data.family_history.toLowerCase() === 'no') score += 5;
  if (data.smoking_vaping.toLowerCase() === 'no') score += 6;
  const alcoholDrinks = parseInt(data.alcohol_drinks);
  if (alcoholDrinks === 0) score += 6;
  else if (alcoholDrinks <= 7) score += 4;
  else if (alcoholDrinks <= 14) score += 2;
  switch (data.headaches_body_aches.toLowerCase()) {
    case 'never': score += 6; break;
    case 'rarely': score += 4; break;
    case 'sometimes': score += 2; break;
  }
  if (data.weight_changes.toLowerCase() === 'no') score += 5;
  return score;
}

client.on('ready', () => {
  logger.info('WhatsApp client is ready!');
  console.log('WhatsApp client is ready!');
  testDatabase().catch(err => {
    logger.error(`Startup error: ${err.message}`);
    process.exit(1);
  });
});

client.on('qr', (qr) => {
  logger.info('QR code generated');
  qrcode.generate(qr, { small: true });
  console.log('Scan the QR code with your WhatsApp app.');
});

client.on('message', async (message) => {
  const userId = message.from;
  const userMessage = message.body.toLowerCase().trim();
  let userState = userStates.get(userId) || { state: 'initial', data: {} };

  logger.info(`Received message from ${userId}: ${message.body}`);

  try {
    if (userMessage === '/help') {
      await message.reply(HELP_MESSAGE);
      logger.info(`Sent help menu to ${userId}`);
      return;
    }

    if (userMessage === '/cancel') {
      if (userState.state === 'initial') {
        await message.reply('No operation to cancel. Send /start to begin or /help for commands.');
        logger.info(`User ${userId} attempted to cancel with no active operation`);
      } else {
        userState = { state: 'initial', data: {} };
        userStates.set(userId, userState);
        await message.reply('Operation cancelled. Send /start to begin again or /help for commands.');
        logger.info(`User ${userId} cancelled operation`);
      }
      return;
    }

    if (userMessage === '/start') {
      const isOnboarded = await isUserOnboarded(userId);
      if (isOnboarded) {
        userState = { state: 'initial', data: {} };
        userStates.set(userId, userState);
        await message.reply('You’ve already completed onboarding! Use /help to see available commands.');
        logger.info(`User ${userId} already onboarded, prompted for /help`);
        return;
      }
      userState = { state: 'awaiting_tnc_response', data: {} };
      userStates.set(userId, userState);
      await message.reply(INTRODUCTION_MESSAGE);
      logger.info(`Sent introduction and T&C to ${userId}`);
      return;
    }

    if (userMessage === '/diagnose') {
      const isOnboarded = await isUserOnboarded(userId);
      if (!isOnboarded) {
        await message.reply('Please complete onboarding first. Send /start to begin.');
        logger.info(`User ${userId} attempted /diagnose without onboarding`);
        return;
      }
      userState = { state: 'diagnosing', data: {}, step: 0 };
      userStates.set(userId, userState);
      await message.reply(DIAGNOSIS_STEPS[0].prompt);
      logger.info(`Started diagnosis flow for ${userId}`);
      return;
    }

    if (userMessage === '/assessment') {
      const isOnboarded = await isUserOnboarded(userId);
      if (!isOnboarded) {
        await message.reply('Please complete onboarding first. Send /start to begin.');
        logger.info(`User ${userId} attempted /assessment without onboarding`);
        return;
      }
      userState = { state: 'assessing', data: {}, step: 0 };
      userStates.set(userId, userState);
      await message.reply(ASSESSMENT_STEPS[0].prompt);
      logger.info(`Started assessment flow for ${userId}`);
      return;
    }

    if (userMessage === '/fitness') {
      const isOnboarded = await isUserOnboarded(userId);
      if (!isOnboarded) {
        await message.reply('Please complete onboarding first. Send /start to begin.');
        logger.info(`User ${userId} attempted /fitness without onboarding`);
        return;
      }
      userState = { state: 'fitness', data: {}, step: 0 };
      userStates.set(userId, userState);
      await message.reply(FITNESS_STEPS[0].prompt);
      logger.info(`Started fitness flow for ${userId}`);
      return;
    }

    if (userMessage === '/meal') {
      const isOnboarded = await isUserOnboarded(userId);
      if (!isOnboarded) {
        await message.reply('Please complete onboarding first. Send /start to begin.');
        logger.info(`User ${userId} attempted /meal without onboarding`);
        return;
      }
      userState = { state: 'meal', data: {}, step: 0 };
      userStates.set(userId, userState);
      await message.reply(MEAL_STEPS[0].prompt);
      logger.info(`Started meal plan flow for ${userId}`);
      return;
    }

    if (userMessage === '/cycle') {
      const isOnboarded = await isUserOnboarded(userId);
      if (!isOnboarded) {
        await message.reply('Please complete onboarding first. Send /start to begin.');
        logger.info(`User ${userId} attempted /cycle without onboarding`);
        return;
      }

      const userDetails = await getUserDetails(userId);
      if (!userDetails) {
        await message.reply('Error retrieving your profile. Please try again with /start.');
        logger.error(`Failed to retrieve profile for ${userId}`);
        return;
      }

      if (userDetails.sex.toLowerCase() !== 'female' || userDetails.menstrual_cycle_type.toLowerCase() === 'none') {
        await message.reply('This feature is only available for users with a menstrual cycle. Use /help for other commands.');
        logger.info(`User ${userId} ineligible for /cycle feature`);
        return;
      }

      const cycleData = await getMenstrualCycle(userId);
      if (cycleData) {
        await message.reply(`
*Your Menstrual Cycle Details*

- Last Period: ${cycleData.last_period_date}
- Average Cycle Length: ${cycleData.average_cycle_length} days
- Predicted Next Period: ${cycleData.predicted_next_period}

Would you like to update your cycle details? Reply with *yes* to update or *no* to keep this data.
        `);
        userState = { state: 'cycle_update_choice', data: {} };
        userStates.set(userId, userState);
        logger.info(`Prompted ${userId} to update cycle data`);
        return;
      }

      userState = { state: 'cycle_tracking', data: {}, step: 0 };
      userStates.set(userId, userState);
      await message.reply(CYCLE_STEPS[0].prompt);
      logger.info(`Started cycle tracking flow for ${userId}`);
      return;
    }

    if (userMessage === '/medication') {
      const isOnboarded = await isUserOnboarded(userId);
      if (!isOnboarded) {
        await message.reply('Please complete onboarding first. Send /start to begin.');
        logger.info(`User ${userId} attempted /medication without onboarding`);
        return;
      }

      const reminders = await getMedicationReminders(userId);
      if (reminders && reminders.length > 0) {
        let reminderList = '*Your Medication Reminders*\n\n';
        reminders.forEach(r => {
          reminderList += `- ${r.medication_name}: ${r.dosage} at ${r.schedule_time} on ${r.days_of_week}\n`;
        });
        reminderList += '\nWould you like to add a new reminder or update an existing one? Reply with *add* or *update*.';
        await message.reply(reminderList);
        userState = { state: 'medication_choice', data: { existingReminders: reminders } };
        userStates.set(userId, userState);
        logger.info(`Prompted ${userId} to add or update medication reminder`);
        return;
      }

      userState = { state: 'medication_setup', data: {}, step: 0 };
      userStates.set(userId, userState);
      await message.reply(MEDICATION_STEPS[0].prompt);
      logger.info(`Started medication reminder setup for ${userId}`);
      return;
    }

    if (userMessage.startsWith('/ask')) {
      const isOnboarded = await isUserOnboarded(userId);
      if (!isOnboarded) {
        await message.reply('Please complete onboarding first. Send /start to begin.');
        logger.info(`User ${userId} attempted /ask without onboarding`);
        return;
      }

      const question = message.body.slice(4).trim();
      if (!question) {
        await message.reply('Please provide a health-related question after /ask (e.g., /ask What is a balanced diet?).');
        logger.info(`User ${userId} sent empty /ask command`);
        return;
      }

      const answer = await answerHealthQuestion(question);
      if (!answer) {
        await message.reply('Sorry, I couldn’t answer your question. Please try again or consult a healthcare professional.');
        logger.error(`Failed to answer health question for ${userId}: ${question}`);
        return;
      }

      await message.reply(`
*Health Question Answer*

**Question**: ${question}

${answer}

⚠️ *Please consult a doctor for personalized health advice.*
Use /ask to ask another question or /help for other commands.
      `);
      logger.info(`Answered health question for ${userId}: ${question}`);
      return;
    }

    if (userState.state === 'awaiting_tnc_response') {
      if (userMessage === 'accept') {
        userState = { state: 'onboarding', data: {}, step: 0 };
        userStates.set(userId, userState);
        await message.reply(ONBOARDING_STEPS[0].prompt);
        logger.info(`User ${userId} accepted T&C, starting onboarding`);
      } else if (userMessage === 'deny') {
        userState = { state: 'initial', data: {} };
        userStates.set(userId, userState);
        await message.reply('Thank you for your time. If you change your mind, send /start to begin again. Goodbye!');
        logger.info(`User ${userId} denied T&C, exiting`);
      } else {
        await message.reply('Please reply with *accept* or *deny* to continue.');
        logger.info(`Invalid T&C response from ${userId}: ${userMessage}`);
      }
      return;
    }

    if (userState.state === 'onboarding') {
      let currentStep = userState.step;
      let steps = [...ONBOARDING_STEPS];

      if (userState.data.sex === 'female' && !steps.find(step => step.field === 'menstrual_cycle_type')) {
        steps.push(MENSTRUAL_CYCLE_STEP);
      }

      if (currentStep >= steps.length) {
        const saved = await saveUserProfile(userId, userState.data);
        if (saved) {
          userState = { state: 'awaiting_assessment_choice', data: {} };
          userStates.set(userId, userState);
          await message.reply('Onboarding complete! Would you like to take a health assessment test now, later, or never? Reply with *now*, *later*, or *never*.');
          logger.info(`User ${userId} completed onboarding, prompted for assessment`);
        }
        return;
      }

      const step = steps[currentStep];
      const validationError = step.validate(userMessage);

      if (validationError) {
        await message.reply(validationError);
        logger.info(`Validation error for ${userId} on ${step.field}: ${userMessage}`);
        return;
      }

      userState.data[step.field] = userMessage;
      userState.step = currentStep + 1;
      userStates.set(userId, userState);

      if (userState.step < steps.length) {
        await message.reply(steps[userState.step].prompt);
        logger.info(`Prompted ${userId} for ${steps[userState.step].field}`);
      } else {
        const saved = await saveUserProfile(userId, userState.data);
        if (saved) {
          userState = { state: 'awaiting_assessment_choice', data: {} };
          userStates.set(userId, userState);
          await message.reply('Onboarding complete! Would you like to take a health assessment test now, later, or never? Reply with *now*, *later*, or *never*.');
          logger.info(`User ${userId} completed onboarding, prompted for assessment`);
        }
      }
      return;
    }

    if (userState.state === 'awaiting_assessment_choice') {
      if (userMessage === 'now') {
        userState = { state: 'assessing', data: {}, step: 0 };
        userStates.set(userId, userState);
        await message.reply(ASSESSMENT_STEPS[0].prompt);
        logger.info(`User ${userId} chose to take assessment now`);
      } else if (userMessage === 'later') {
        scheduleAssessmentReminder(userId);
        userState = { state: 'initial', data: {} };
        userStates.set(userId, userState);
        await message.reply('Alright, I’ll remind you in 48 hours. You can also start anytime with /assessment.');
        logger.info(`User ${userId} chose to take assessment later`);
      } else if (userMessage === 'never') {
        userState = { state: 'initial', data: {} };
        userStates.set(userId, userState);
        await message.reply('Got it. You can always start the assessment later with /assessment. Use /help for other commands.');
        logger.info(`User ${userId} declined assessment`);
      } else {
        await message.reply('Please reply with *now*, *later*, or *never*.');
        logger.info(`Invalid assessment choice from ${userId}: ${userMessage}`);
      }
      return;
    }

    if (userState.state === 'diagnosing') {
      const currentStep = userState.step;
      const steps = DIAGNOSIS_STEPS;

      if (currentStep >= steps.length) {
        const analysis = await analyzeSymptoms(userState.data.symptoms, userState.data.severity, userState.data.duration);
        if (!analysis) {
          await message.reply('Sorry, I couldn’t analyze your symptoms. Please try again or consult a doctor.');
          logger.error(`Failed to analyze symptoms for ${userId}`);
          userState = { state: 'initial', data: {} };
          userStates.set(userId, userState);
          return;
        }

        userState.data.diagnosis = analysis;
        userState.data.home_care = analysis;
        userState.data.red_flags = analysis;

        const saved = await saveDiagnosis(userId, userState.data);
        if (!saved) {
          await message.reply('Error saving diagnosis. Please try again or consult a doctor.');
          logger.error(`Failed to save diagnosis for ${userId}`);
          userState = { state: 'initial', data: {} };
          userStates.set(userId, userState);
          return;
        }

        scheduleFollowUpReminder(userId, userState.data.severity);

        await message.reply(`
*Symptom Analysis Results*

${analysis}

⚠️ *Please consult a doctor for a professional diagnosis and treatment.*
Use /diagnose to report new symptoms or /help for other commands.
        `);
        logger.info(`Sent diagnosis results to ${userId}`);
        userState = { state: 'initial', data: {} };
        userStates.set(userId, userState);
        return;
      }

      const step = steps[currentStep];
      const validationError = step.validate(userMessage);

      if (validationError) {
        await message.reply(validationError);
        logger.info(`Validation error for ${userId} on ${step.field}: ${userMessage}`);
        return;
      }

      userState.data[step.field] = userMessage;
      userState.step = currentStep + 1;
      userStates.set(userId, userState);

      if (userState.step < steps.length) {
        await message.reply(steps[userState.step].prompt);
        logger.info(`Prompted ${userId} for ${steps[userState.step].field}`);
      } else {
        const analysis = await analyzeSymptoms(userState.data.symptoms, userState.data.severity, userState.data.duration);
        if (!analysis) {
          await message.reply('Sorry, I couldn’t analyze your symptoms. Please try again or consult a doctor.');
          logger.error(`Failed to analyze symptoms for ${userId}`);
          userState = { state: 'initial', data: {} };
          userStates.set(userId, userState);
          return;
        }

        userState.data.diagnosis = analysis;
        userState.data.home_care = analysis;
        userState.data.red_flags = analysis;

        const saved = await saveDiagnosis(userId, userState.data);
        if (!saved) {
          await message.reply('Error saving diagnosis. Please try again or consult a doctor.');
          logger.error(`Failed to save diagnosis for ${userId}`);
          userState = { state: 'initial', data: {} };
          userStates.set(userId, userState);
          return;
        }

        scheduleFollowUpReminder(userId, userState.data.severity);

        await message.reply(`
*Symptom Analysis Results*

${analysis}

⚠️ *Please consult a doctor for a professional diagnosis and treatment.*
Use /diagnose to report new symptoms or /help for other commands.
        `);
        logger.info(`Sent diagnosis results to ${userId}`);
        userState = { state: 'initial', data: {} };
        userStates.set(userId, userState);
      }
      return;
    }

    if (userState.state === 'assessing') {
      const currentStep = userState.step;
      const steps = ASSESSMENT_STEPS;

      if (currentStep >= steps.length) {
        const score = calculateHealthScore(userState.data);
        userState.data.score = score;
        
        const analysis = await analyzeHealthAssessment(userState.data, score);
        if (!analysis) {
          await message.reply('Sorry, I couldn’t analyze your health assessment. Please try again with /assessment.');
          logger.error(`Failed to analyze health assessment for ${userId}`);
          userState = { state: 'initial', data: {} };
          userStates.set(userId, userState);
          return;
        }

        userState.data.analysis = analysis;
        userState.data.recommendations = analysis;

        const saved = await saveAssessment(userId, userState.data);
        if (!saved) {
          await message.reply('Error saving health assessment. Please try again with /assessment.');
          logger.error(`Failed to save health assessment for ${userId}`);
          userState = { state: 'initial', data: {} };
          userStates.set(userId, userState);
          return;
        }

        await message.reply(`
*Health Assessment Results*

**Score**: ${score}/100

${analysis}

⚠️ *Please consult a doctor for personalized health advice.*
Use /assessment to take another test or /help for other commands.
        `);
        logger.info(`Sent health assessment results to ${userId}`);
        userState = { state: 'initial', data: {} };
        userStates.set(userId, userState);
        return;
      }

      const step = steps[currentStep];
      const validationError = step.validate(userMessage);

      if (validationError) {
        await message.reply(validationError);
        logger.info(`Validation error for ${userId} on ${step.field}: ${userMessage}`);
        return;
      }

      userState.data[step.field] = userMessage;
      userState.step = currentStep + 1;
      userStates.set(userId, userState);

      if (userState.step < steps.length) {
        await message.reply(steps[userState.step].prompt);
        logger.info(`Prompted ${userId} for ${steps[userState.step].field}`);
      } else {
        const score = calculateHealthScore(userState.data);
        userState.data.score = score;
        
        const analysis = await analyzeHealthAssessment(userState.data, score);
        if (!analysis) {
          await message.reply('Sorry, I couldn’t analyze your health assessment. Please try again with /assessment.');
          logger.error(`Failed to analyze health assessment for ${userId}`);
          userState = { state: 'initial', data: {} };
          userStates.set(userId, userState);
          return;
        }

        userState.data.analysis = analysis;
        userState.data.recommendations = analysis;

        const saved = await saveAssessment(userId, userState.data);
        if (!saved) {
          await message.reply('Error saving health assessment. Please try again with /assessment.');
          logger.error(`Failed to save health assessment for ${userId}`);
          userState = { state: 'initial', data: {} };
          userStates.set(userId, userState);
          return;
        }

        await message.reply(`
*Health Assessment Results*

**Score**: ${score}/100

${analysis}

⚠️ *Please consult a doctor for personalized health advice.*
Use /assessment to take another test or /help for other commands.
        `);
        logger.info(`Sent health assessment results to ${userId}`);
        userState = { state: 'initial', data: {} };
        userStates.set(userId, userState);
      }
      return;
    }

    if (userState.state === 'fitness') {
      const currentStep = userState.step;
      const steps = FITNESS_STEPS;

      if (currentStep >= steps.length) {
        const fitnessPlan = await generateFitnessPlan(userState.data);
        if (!fitnessPlan) {
          await message.reply('Sorry, I couldn’t generate your fitness plan. Please try again with /fitness.');
          logger.error(`Failed to generate fitness plan for ${userId}`);
          userState = { state: 'initial', data: {} };
          userStates.set(userId, userState);
          return;
        }

        userState.data.fitness_plan = fitnessPlan;

        const saved = await saveFitnessPlan(userId, userState.data);
        if (!saved) {
          await message.reply('Error saving your fitness plan. Please try again with /fitness.');
          logger.error(`Failed to save fitness plan for ${userId}`);
          userState = { state: 'initial', data: {} };
          userStates.set(userId, userState);
          return;
        }

        scheduleFitnessReminder(userId);

        await message.reply(`
*Your Personalized Fitness Plan*

${fitnessPlan}

I’ll remind you daily at 7:00 AM to follow this plan. Use /fitness to generate a new plan or /help for other commands.
        `);
        logger.info(`Sent fitness plan to ${userId}`);
        userState = { state: 'initial', data: {} };
        userStates.set(userId, userState);
        return;
      }

      const step = steps[currentStep];
      const validationError = step.validate(userMessage);

      if (validationError) {
        await message.reply(validationError);
        logger.info(`Validation error for ${userId} on ${step.field}: ${userMessage}`);
        return;
      }

      userState.data[step.field] = userMessage;
      userState.step = currentStep + 1;
      userStates.set(userId, userState);

      if (userState.step < steps.length) {
        await message.reply(steps[userState.step].prompt);
        logger.info(`Prompted ${userId} for ${steps[userState.step].field}`);
      } else {
        const fitnessPlan = await generateFitnessPlan(userState.data);
        if (!fitnessPlan) {
          await message.reply('Sorry, I couldn’t generate your fitness plan. Please try again with /fitness.');
          logger.error(`Failed to generate fitness plan for ${userId}`);
          userState = { state: 'initial', data: {} };
          userStates.set(userId, userState);
          return;
        }

        userState.data.fitness_plan = fitnessPlan;

        const saved = await saveFitnessPlan(userId, userState.data);
        if (!saved) {
          await message.reply('Error saving your fitness plan. Please try again with /fitness.');
          logger.error(`Failed to save fitness plan for ${userId}`);
          userState = { state: 'initial', data: {} };
          userStates.set(userId, userState);
          return;
        }

        scheduleFitnessReminder(userId);

        await message.reply(`
*Your Personalized Fitness Plan*

${fitnessPlan}

I’ll remind you daily at 7:00 AM to follow this plan. Use /fitness to generate a new plan or /help for other commands.
        `);
        logger.info(`Sent fitness plan to ${userId}`);
        userState = { state: 'initial', data: {} };
        userStates.set(userId, userState);
      }
      return;
    }

    if (userState.state === 'meal') {
      const currentStep = userState.step;
      const steps = MEAL_STEPS;

      if (currentStep >= steps.length) {
        const mealPlan = await generateMealPlan(userState.data);
        if (!mealPlan) {
          await message.reply('Sorry, I couldn’t generate your meal plan. Please try again with /meal.');
          logger.error(`Failed to generate meal plan for ${userId}`);
          userState = { state: 'initial', data: {} };
          userStates.set(userId, userState);
          return;
        }

        userState.data.meal_plan = mealPlan;

        const saved = await saveMealPlan(userId, userState.data);
        if (!saved) {
          await message.reply('Error saving your meal plan. Please try again with /meal.');
          logger.error(`Failed to save meal plan for ${userId}`);
          userState = { state: 'initial', data: {} };
          userStates.set(userId, userState);
          return;
        }

        scheduleMealReminder(userId);

        await message.reply(`
*Your Personalized Meal Plan*

${mealPlan}

I’ll remind you daily at 8:00 AM to follow this plan. Use /meal to generate a new plan or /help for other commands.
        `);
        logger.info(`Sent meal plan to ${userId}`);
        userState = { state: 'initial', data: {} };
        userStates.set(userId, userState);
        return;
      }

      const step = steps[currentStep];
      const validationError = step.validate(userMessage);

      if (validationError) {
        await message.reply(validationError);
        logger.info(`Validation error for ${userId} on ${step.field}: ${userMessage}`);
        return;
      }

      userState.data[step.field] = userMessage;
      userState.step = currentStep + 1;
      userStates.set(userId, userState);

      if (userState.step < steps.length) {
        await message.reply(steps[userState.step].prompt);
        logger.info(`Prompted ${userId} for ${steps[userState.step].field}`);
      } else {
        const mealPlan = await generateMealPlan(userState.data);
        if (!mealPlan) {
          await message.reply('Sorry, I couldn’t generate your meal plan. Please try again with /meal.');
          logger.error(`Failed to generate meal plan for ${userId}`);
          userState = { state: 'initial', data: {} };
          userStates.set(userId, userState);
          return;
        }

        userState.data.meal_plan = mealPlan;

        const saved = await saveMealPlan(userId, userState.data);
        if (!saved) {
          await message.reply('Error saving your meal plan. Please try again with /meal.');
          logger.error(`Failed to save meal plan for ${userId}`);
          userState = { state: 'initial', data: {} };
          userStates.set(userId, userState);
          return;
        }

        scheduleMealReminder(userId);

        await message.reply(`
*Your Personalized Meal Plan*

${mealPlan}

I’ll remind you daily at 8:00 AM to follow this plan. Use /meal to generate a new plan or /help for other commands.
        `);
        logger.info(`Sent meal plan to ${userId}`);
        userState = { state: 'initial', data: {} };
        userStates.set(userId, userState);
      }
      return;
    }

    if (userState.state === 'cycle_update_choice') {
      if (userMessage === 'yes') {
        userState = { state: 'cycle_tracking', data: {}, step: 0 };
        userStates.set(userId, userState);
        await message.reply(CYCLE_STEPS[0].prompt);
        logger.info(`User ${userId} chose to update cycle data`);
      } else if (userMessage === 'no') {
        userState = { state: 'initial', data: {} };
        userStates.set(userId, userState);
        await message.reply('Got it. Your cycle data remains unchanged. Use /cycle to update later or /help for other commands.');
        logger.info(`User ${userId} chose not to update cycle data`);
      } else {
        await message.reply('Please reply with *yes* or *no*.');
        logger.info(`Invalid cycle update choice from ${userId}: ${userMessage}`);
      }
      return;
    }

    if (userState.state === 'cycle_tracking') {
      const currentStep = userState.step;
      const steps = CYCLE_STEPS;

      if (currentStep >= steps.length) {
        const lastPeriodDate = userState.data.last_period_date;
        const averageCycleLength = userState.data.average_cycle_length;
        const predictedNextPeriod = calculateNextPeriod(lastPeriodDate, averageCycleLength);

        userState.data.predicted_next_period = predictedNextPeriod;

        const saved = await saveMenstrualCycle(userId, userState.data);
        if (!saved) {
          await message.reply('Error saving your cycle data. Please try again with /cycle.');
          logger.error(`Failed to save cycle data for ${userId}`);
          userState = { state: 'initial', data: {} };
          userStates.set(userId, userState);
          return;
        }

        schedulePeriodReminder(userId, predictedNextPeriod);

        await message.reply(`
*Menstrual Cycle Tracking*

- Last Period: ${lastPeriodDate}
- Average Cycle Length: ${averageCycleLength} days
- Predicted Next Period: ${predictedNextPeriod}

I'll remind you 3 days before your predicted period. Use /cycle to update your details or /help for other commands.
        `);
        logger.info(`Sent cycle tracking results to ${userId}`);
        userState = { state: 'initial', data: {} };
        userStates.set(userId, userState);
        return;
      }

      const step = steps[currentStep];
      const validationError = step.validate(userMessage);

      if (validationError) {
        await message.reply(validationError);
        logger.info(`Validation error for ${userId} on ${step.field}: ${userMessage}`);
        return;
      }

      userState.data[step.field] = userMessage;
      userState.step = currentStep + 1;
      userStates.set(userId, userState);

      if (userState.step < steps.length) {
        await message.reply(steps[userState.step].prompt);
        logger.info(`Prompted ${userId} for ${steps[userState.step].field}`);
      } else {
        const lastPeriodDate = userState.data.last_period_date;
        const averageCycleLength = userState.data.average_cycle_length;
        const predictedNextPeriod = calculateNextPeriod(lastPeriodDate, averageCycleLength);

        userState.data.predicted_next_period = predictedNextPeriod;

        const saved = await saveMenstrualCycle(userId, userState.data);
        if (!saved) {
          await message.reply('Error saving your cycle data. Please try again with /cycle.');
          logger.error(`Failed to save cycle data for ${userId}`);
          userState = { state: 'initial', data: {} };
          userStates.set(userId, userState);
          return;
        }

        schedulePeriodReminder(userId, predictedNextPeriod);

        await message.reply(`
*Menstrual Cycle Tracking*

- Last Period: ${lastPeriodDate}
- Average Cycle Length: ${averageCycleLength} days
- Predicted Next Period: ${predictedNextPeriod}

I'll remind you 3 days before your predicted period. Use /cycle to update your details or /help for other commands.
        `);
        logger.info(`Sent cycle tracking results to ${userId}`);
        userState = { state: 'initial', data: {} };
        userStates.set(userId, userState);
      }
      return;
    }

    if (userState.state === 'medication_choice') {
      if (userMessage === 'add') {
        userState = { state: 'medication_setup', data: {}, step: 0 };
        userStates.set(userId, userState);
        await message.reply(MEDICATION_STEPS[0].prompt);
        logger.info(`User ${userId} chose to add a new medication reminder`);
      } else if (userMessage === 'update') {
        let reminderList = '*Which medication would you like to update?*\n\n';
        userState.data.existingReminders.forEach((r, index) => {
          reminderList += `${index + 1}. ${r.medication_name}: ${r.dosage} at ${r.schedule_time} on ${r.days_of_week}\n`;
        });
        reminderList += '\nReply with the number of the medication to update (e.g., 1).';
        userState = { state: 'medication_select_update', data: userState.data };
        userStates.set(userId, userState);
        await message.reply(reminderList);
        logger.info(`Prompted ${userId} to select medication to update`);
      } else {
        await message.reply('Please reply with *add* or *update*.');
        logger.info(`Invalid medication choice from ${userId}: ${userMessage}`);
      }
      return;
    }

    if (userState.state === 'medication_select_update') {
      const selectedIndex = parseInt(userMessage) - 1;
      const reminders = userState.data.existingReminders;

      if (isNaN(selectedIndex) || selectedIndex < 0 || selectedIndex >= reminders.length) {
        await message.reply('Please reply with a valid number from the list.');
        logger.info(`Invalid medication selection from ${userId}: ${userMessage}`);
        return;
      }

      userState.data.selectedMedication = reminders[selectedIndex].medication_name;
      userState = { state: 'medication_setup', data: { medication_name: reminders[selectedIndex].medication_name }, step: 1 };
      userStates.set(userId, userState);
      await message.reply(MEDICATION_STEPS[1].prompt);
      logger.info(`User ${userId} selected medication ${reminders[selectedIndex].medication_name} to update`);
      return;
    }

    if (userState.state === 'medication_setup') {
      const currentStep = userState.step;
      const steps = MEDICATION_STEPS;

      if (currentStep >= steps.length) {
        const saved = await saveMedicationReminder(userId, userState.data);
        if (!saved) {
          await message.reply('Error saving your medication reminder. Please try again with /medication.');
          logger.error(`Failed to save medication reminder for ${userId}`);
          userState = { state: 'initial', data: {} };
          userStates.set(userId, userState);
          return;
        }

        scheduleMedicationReminder(userId, userState.data);

        await message.reply(`
*Medication Reminder Set*

- Medication: ${userState.data.medication_name}
- Dosage: ${userState.data.dosage}
- Time: ${userState.data.schedule_time}
- Days: ${userState.data.days_of_week}

I'll remind you as scheduled. Use /medication to add or update reminders, or /help for other commands.
        `);
        logger.info(`Set medication reminder for ${userId}: ${userState.data.medication_name}`);
        userState = { state: 'initial', data: {} };
        userStates.set(userId, userState);
        return;
      }

      const step = steps[currentStep];
      const validationError = step.validate(userMessage);

      if (validationError) {
        await message.reply(validationError);
        logger.info(`Validation error for ${userId} on ${step.field}: ${userMessage}`);
        return;
      }

      userState.data[step.field] = userMessage;
      userState.step = currentStep + 1;
      userStates.set(userId, userState);

      if (userState.step < steps.length) {
        await message.reply(steps[userState.step].prompt);
        logger.info(`Prompted ${userId} for ${steps[userState.step].field}`);
      } else {
        const saved = await saveMedicationReminder(userId, userState.data);
        if (!saved) {
          await message.reply('Error saving your medication reminder. Please try again with /medication.');
          logger.error(`Failed to save medication reminder for ${userId}`);
          userState = { state: 'initial', data: {} };
          userStates.set(userId, userState);
          return;
        }

        scheduleMedicationReminder(userId, userState.data);

        await message.reply(`
*Medication Reminder Set*

- Medication: ${userState.data.medication_name}
- Dosage: ${userState.data.dosage}
- Time: ${userState.data.schedule_time}
- Days: ${userState.data.days_of_week}

I'll remind you as scheduled. Use /medication to add or update reminders, or /help for other commands.
        `);
        logger.info(`Set medication reminder for ${userId}: ${userState.data.medication_name}`);
        userState = { state: 'initial', data: {} };
        userStates.set(userId, userState);
      }
      return;
    }

    await message.reply('I didn’t understand that. Please use a command like /start or /help to get started.');
    logger.info(`Unrecognized input from ${userId}: ${userMessage}`);
  } catch (err) {
    logger.error(`Error handling message from ${userId}: ${err.stack}`);
    await message.reply('Sorry, something went wrong. Please try again or use /help for assistance.');
  }
});

client.initialize().catch(err => {
  logger.error(`Failed to initialize WhatsApp client: ${err.message}`);
  process.exit(1);
});