import * as fs from 'fs';
import * as path from 'path';
import { ReelGenerator } from './src';

async function main() {
  const inputFolder = './input';
  const outputFolder = './output';

  // Create input and output folders if they don't exist
  if (!fs.existsSync(inputFolder)) {
    fs.mkdirSync(inputFolder, { recursive: true });
    console.log(`📁 Created input folder: ${inputFolder}`);
    console.log('   Please add audio files to this folder and run again.');
    return;
  }

  if (!fs.existsSync(outputFolder)) {
    fs.mkdirSync(outputFolder, { recursive: true });
    console.log(`📁 Created output folder: ${outputFolder}`);
  }

  // Get all audio files from input folder
  const files = fs.readdirSync(inputFolder);
  const audioExtensions = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'];
  const audioFiles = files.filter(file => {
    const ext = path.extname(file).toLowerCase();
    return audioExtensions.includes(ext);
  });

  if (audioFiles.length === 0) {
    console.log('❌ No audio files found in input folder.');
    console.log(`   Supported formats: ${audioExtensions.join(', ')}`);
    return;
  }

  console.log(`🎵 Found ${audioFiles.length} audio file(s) to process\n`);

  const generator = new ReelGenerator();

  // Process each audio file
  for (let i = 0; i < audioFiles.length; i++) {
    const audioFile = audioFiles[i];
    const audioPath = path.join(inputFolder, audioFile);
    const fileName = path.parse(audioFile).name;
    const outputPath = path.join(outputFolder, `${fileName}.mp4`);

    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📹 Processing (${i + 1}/${audioFiles.length}): ${audioFile}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    try {
      await generator.generateReel({
        audioPath,
        outputPath,

        // Transcribe audio to text
        transcribe: true,
        openaiApiKey: process.env.OPENAI_API_KEY,

        // Use video backgrounds (optional - comment out if not needed)
        backgroundVideosFolder: './backgrounds',

        // Customization options
        maxCharsPerSlide: 35,
        slideWidth: 1080,
        slideHeight: 1920,
        textColor: '#ffffff',
      });

      console.log(`✅ Successfully generated: ${outputPath}\n`);
    } catch (error) {
      console.error(`❌ Error processing ${audioFile}:`, error);
      console.log('   Continuing with next file...\n');
    }
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🎉 Processing complete!`);
  console.log(`   Processed: ${audioFiles.length} file(s)`);
  console.log(`   Output folder: ${outputFolder}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}

main().catch(console.error);
