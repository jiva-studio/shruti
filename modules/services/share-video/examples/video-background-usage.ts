import { ReelGenerator } from '../src';

async function main() {
  const generator = new ReelGenerator();

  // Generate reel with video backgrounds
  await generator.generateReel({
    audioPath: './examples/audio/sample.mp3',
    outputPath: './output/video-bg-reel.mp4',

    // Transcribe audio to text
    transcribe: true,
    openaiApiKey: process.env.OPENAI_API_KEY,

    // Use video backgrounds instead of solid color
    // The generator will randomly select videos from this folder
    // and extract frames (cropped from center) for each slide
    backgroundVideosFolder: './backgrounds',

    // Optional customization
    maxCharsPerSlide: 35,
    slideWidth: 1080,
    slideHeight: 1920,
    textColor: '#ffffff', // White text with black outline for visibility
  });
}

main().catch(console.error);
