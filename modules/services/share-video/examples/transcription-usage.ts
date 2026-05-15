import { ReelGenerator } from '../src';

async function main() {
  const generator = new ReelGenerator();

  // Generate reel with automatic audio transcription
  await generator.generateReel({
    audioPath: './examples/audio/sample.mp3',
    outputPath: './output/transcribed-reel.mp4',

    // Enable transcription - text will be extracted from audio automatically
    transcribe: true,

    // Provide your OpenAI API key (or set OPENAI_API_KEY env variable)
    openaiApiKey: process.env.OPENAI_API_KEY,

    // Optional customization
    maxCharsPerSlide: 120,
    slideWidth: 1080,
    slideHeight: 1920,
    backgroundColor: '#1a1a2e',
    textColor: '#eaeaea',
  });
}

main().catch(console.error);
