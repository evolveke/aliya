const { CohereClient } = require('cohere-ai');
require('dotenv').config();

// Initialize the Cohere client with the API key
const cohere = new CohereClient({
  token: process.env.COHERE_API_KEY
});

async function analyzeSymptoms(symptoms, severity, duration) {
  try {
    const prompt = `
You are a health assistant providing symptom analysis for informational purposes only. Based on the following symptoms, severity, and duration, provide possible conditions, home care advice, and any red flags that require immediate medical attention. Do not provide a definitive diagnosis, as you are not a doctor. Always advise the user to consult a doctor for professional medical advice.

Symptoms: ${symptoms}
Severity: ${severity}
Duration: ${duration}

Format your response as follows:
**Possible Conditions**: [List possible conditions]
**Home Care**: [Provide home care advice]
**Red Flags**: [List any red flags requiring immediate medical attention]
    `;
    const response = await cohere.generate({
      model: 'command-r-plus',
      prompt: prompt,
      maxTokens: 300,
      temperature: 0.7
    });
    return response.generations[0].text.trim();
  } catch (err) {
    console.error('Error in analyzeSymptoms:', err.message);
    return null;
  }
}

async function analyzeHealthAssessment(data, score) {
  try {
    const prompt = `
You are a health assistant providing a health assessment analysis for informational purposes only. Based on the following user data and health score, provide an analysis of their overall health and actionable recommendations to improve their health. Do not provide a definitive diagnosis, as you are not a doctor. Always advise the user to consult a doctor for professional medical advice.

User Data:
- Overall Health: ${data.overall_health}
- Fatigue After Sleep: ${data.fatigue_after_sleep}
- Fruit/Veggie Servings: ${data.fruit_veggie_servings}
- Sugary Drinks/Snacks: ${data.sugary_drinks_snacks}
- Exercise Days: ${data.exercise_days}
- Breaks from Sitting: ${data.breaks_from_sitting}
- Sleep Hours: ${data.sleep_hours}
- Wake Refreshed: ${data.wake_refreshed}
- Stress/Anxiety: ${data.stress_anxiety}
- Relaxation Techniques: ${data.relaxation_techniques}
- Chronic Conditions: ${data.chronic_conditions}
- Family History: ${data.family_history}
- Smoking/Vaping: ${data.smoking_vaping}
- Alcohol Drinks: ${data.alcohol_drinks}
- Headaches/Body Aches: ${data.headaches_body_aches}
- Weight Changes: ${data.weight_changes}
Health Score: ${score}/100

Format your response as follows:
**Analysis**: [Provide a brief analysis of the user's health based on the data and score]
**Recommendations**: [List actionable recommendations to improve health]
    `;
    const response = await cohere.generate({
      model: 'command-r-plus',
      prompt: prompt,
      maxTokens: 300,
      temperature: 0.7
    });
    return response.generations[0].text.trim();
  } catch (err) {
    console.error('Error in analyzeHealthAssessment:', err.message);
    return null;
  }
}

async function generateFitnessPlan(data) {
  try {
    const prompt = `
You are a health assistant creating a personalized fitness plan for informational purposes only. Based on the following user data, provide a weekly fitness plan tailored to their goals, activity level, and availability. Always advise the user to consult a doctor before starting any fitness program.

User Data:
- Fitness Goal: ${data.fitness_goal}
- Activity Level: ${data.activity_level}
- Available Days: ${data.available_days}
- Available Minutes per Session: ${data.available_minutes}

Format your response as follows:
**Fitness Goal**: ${data.fitness_goal}
**Weekly Plan**:
- Day 1: [Activity, duration, and details]
- Day 2: [Activity, duration, and details]
(Continue for the number of available days, or suggest rest days if fewer days are available)
**Notes**: [Any additional notes or tips]
    `;
    const response = await cohere.generate({
      model: 'command-r-plus',
      prompt: prompt,
      maxTokens: 300,
      temperature: 0.7
    });
    return response.generations[0].text.trim();
  } catch (err) {
    console.error('Error in generateFitnessPlan:', err.message);
    return null;
  }
}

async function generateMealPlan(data) {
  try {
    const prompt = `
You are a health assistant creating a personalized meal plan for informational purposes only. Based on the following user data, provide a daily meal plan tailored to their dietary preference, health goal, and number of meals per day. Always advise the user to consult a doctor or nutritionist before starting any diet plan.

User Data:
- Dietary Preference: ${data.dietary_preference}
- Health Goal: ${data.health_goal}
- Meals per Day: ${data.meals_per_day}

Format your response as follows:
**Dietary Preference**: ${data.dietary_preference}
**Health Goal**: ${data.health_goal}
**Daily Meal Plan**:
- Meal 1: [Meal details]
- Meal 2: [Meal details]
(Continue for the number of meals per day)
**Notes**: [Any additional notes or tips]
    `;
    const response = await cohere.generate({
      model: 'command-r-plus',
      prompt: prompt,
      maxTokens: 300,
      temperature: 0.7
    });
    return response.generations[0].text.trim();
  } catch (err) {
    console.error('Error in generateMealPlan:', err.message);
    return null;
  }
}

async function answerHealthQuestion(question) {
  try {
    const prompt = `
You are a health assistant answering a general health-related question for informational purposes only. Provide a clear and concise answer to the following question. Do not provide a definitive diagnosis, as you are not a doctor. Always advise the user to consult a doctor for professional medical advice.

Question: ${question}

Format your response as follows:
**Answer**: [Provide a clear and concise answer]
    `;
    const response = await cohere.generate({
      model: 'command-r-plus',
      prompt: prompt,
      maxTokens: 200,
      temperature: 0.7
    });
    return response.generations[0].text.trim();
  } catch (err) {
    console.error('Error in answerHealthQuestion:', err.message);
    return null;
  }
}

module.exports = {
  analyzeSymptoms,
  analyzeHealthAssessment,
  generateFitnessPlan,
  generateMealPlan,
  answerHealthQuestion
};