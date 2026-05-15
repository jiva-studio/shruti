import * as fs from 'fs';
import OpenAI from 'openai';

export interface WordTimestamp {
  word: string;
  start: number;
  end: number;
}

export interface TranscriptionResult {
  text: string;
  words?: WordTimestamp[];
}

/**
 * Transcribes audio file to text using OpenAI Whisper API
 * @param audioPath - Path to the audio file
 * @param apiKey - OpenAI API key (or set OPENAI_API_KEY env variable)
 * @returns Transcribed text
 */
export async function transcribeAudio(
  audioPath: string,
  apiKey?: string
): Promise<string> {
  const result = await transcribeAudioWithTimestamps(audioPath, apiKey);
  return result.text;
}

/**
 * Transcribes audio file with word-level timestamps using OpenAI Whisper API
 * @param audioPath - Path to the audio file
 * @param apiKey - OpenAI API key (or set OPENAI_API_KEY env variable)
 * @returns Transcription result with text and word timestamps
 */
export async function transcribeAudioWithTimestamps(
  audioPath: string,
  apiKey?: string
): Promise<TranscriptionResult> {
  // Get API key from parameter or environment variable
  const key = apiKey || process.env.OPENAI_API_KEY;

  if (!key) {
    throw new Error(
      'OpenAI API key is required. Set OPENAI_API_KEY environment variable or pass apiKey parameter.'
    );
  }

  // Verify file exists
  if (!fs.existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }

  console.log(`Transcribing audio file with timestamps: ${audioPath}`);

  const openai = new OpenAI({ apiKey: key });

  try {
    // Use verbose_json to get word-level timestamps
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: 'whisper-1',
      response_format: 'verbose_json',
      timestamp_granularities: ['word'],
    });

    const text = transcription.text || '';
    const words: WordTimestamp[] = [];

    // Extract word timestamps if available
    if (transcription.words && Array.isArray(transcription.words)) {
      // Whisper returns words WITHOUT punctuation in the words array,
      // but WITH punctuation in the text field. We need to map punctuation
      // from the text back to the words for accurate rendering.
      const textWithPunctuation = text;
      const wordsFromText = textWithPunctuation.split(/\s+/); // Split by whitespace

      // Build a map of word positions to their text representation (with punctuation)
      let textWordIndex = 0;

      transcription.words.forEach((w: any) => {
        const wordWithoutPunc = w.word.trim();
        let finalWord = wordWithoutPunc;

        // Try to find the corresponding word in the text with punctuation
        if (textWordIndex < wordsFromText.length) {
          const textWord = wordsFromText[textWordIndex];
          // Check if this text word starts with our word (allowing for punctuation)
          const textWordClean = textWord.replace(/[.,!?;:'")\]]/g, '').toLowerCase();
          const apiWordClean = wordWithoutPunc.replace(/[.,!?;:'")\]]/g, '').toLowerCase();

          if (textWordClean === apiWordClean || textWord.toLowerCase().startsWith(apiWordClean)) {
            // Use the word from text (which includes punctuation)
            finalWord = textWord;
          } else {
            // Fallback: just use the word from API without incrementing index
            finalWord = wordWithoutPunc;
          }
          textWordIndex++;
        } else {
          // No more words in text, use API word
          finalWord = wordWithoutPunc;
        }

        words.push({
          word: finalWord,
          start: w.start,
          end: w.end,
        });
      });
    }

    console.log(`✓ Transcription completed: ${text.length} characters, ${words.length} words with timestamps`);

    return { text, words };
  } catch (error: any) {
    console.error('Transcription error:', error.message);
    throw new Error(`Failed to transcribe audio: ${error.message}`);
  }
}
