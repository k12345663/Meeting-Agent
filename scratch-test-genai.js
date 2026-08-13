const { GoogleGenAI } = require('@google/genai');
const config = require('./src/core/config');

async function test() {
  const client = new GoogleGenAI({ apiKey: 'dummy' });
  const generationConfig = {
    temperature: 0.1,
    maxOutputTokens: 5,
    thinkingConfig: { thinkingBudget: 0 }
  };
  
  try {
    console.log("Calling generateContentStream...");
    const stream = await client.models.generateContentStream({
      model: 'gemini-3.5-flash',
      contents: "Hello",
      config: generationConfig
    });
    for await (const chunk of stream) {
      console.log(chunk.text);
    }
  } catch (err) {
    console.error("ERROR STACK TRACE:");
    console.error(err.stack);
  }
}

test();
