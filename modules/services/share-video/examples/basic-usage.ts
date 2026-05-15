import { ReelGenerator } from '../src';

async function main() {
  const generator = new ReelGenerator();

  await generator.generateReel({
    audioPath: './examples/audio/sample.mp3',
    text: 'Welcome to our amazing product! This is a revolutionary solution that will change your life. ' +
          'It features cutting-edge technology and intuitive design. ' +
          'Join thousands of satisfied customers today and experience the difference. ' +
          'Don\'t miss out on this incredible opportunity!',
    outputPath: './output/my-reel.mp4',

    // Optional customization
    maxCharsPerSlide: 120,
    slideWidth: 1080,
    slideHeight: 1920,
    backgroundColor: '#1a1a2e',
    textColor: '#eaeaea',
    fontSize: 70,
    fontFamily: 'Arial',
  });
}

main().catch(console.error);
