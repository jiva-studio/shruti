import {
  Injectable,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { spawn } from 'child_process';

@Injectable()
export class AudioProcessingService {
  private readonly logger = new Logger(AudioProcessingService.name);

  /**
   * Extracts a segment from an MP3 file using ffmpeg
   * @param inputFilePath - The input MP3 file path
   * @param outputFilePath - The output MP3 file path
   * @param timeStart - Start time in seconds
   * @param timeEnd - End time in seconds
   * @returns A promise that resolves when the extraction is complete
   */
  async extractSegment(
    inputFilePath: string,
    outputFilePath: string,
    timeStart: number,
    timeEnd: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const duration = timeEnd - timeStart;

      this.logger.log(`Extracting segment from ${inputFilePath} to ${outputFilePath}, start: ${timeStart}s, duration: ${duration}s`);

      // Use ffmpeg to extract the segment
      const ffmpeg = spawn(
        'ffmpeg',
        [
          '-i',
          inputFilePath, // Input file
          '-ss',
          timeStart.toString(), // Start time
          '-t',
          duration.toString(), // Duration
          '-c',
          'copy', // Copy codec (no re-encoding for speed)
          '-y', // Overwrite output file
          outputFilePath, // Output file
        ],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );

      // Handle errors
      ffmpeg.on('error', (error) => {
        this.logger.error(`FFmpeg process error: ${error.message}`);
        reject(new InternalServerErrorException('Audio processing failed'));
      });

      ffmpeg.on('exit', (code, signal) => {
        if (code !== 0) {
          this.logger.error(
            `FFmpeg exited with code ${code}, signal ${signal}`,
          );
          reject(new InternalServerErrorException('Audio processing failed'));
        } else {
          this.logger.log(`Successfully extracted segment to ${outputFilePath}`);
          resolve();
        }
      });

      // Log stderr for debugging
      ffmpeg.stderr.on('data', (data) => {
        this.logger.debug(`FFmpeg stderr: ${data.toString()}`);
      });
    });
  }

  /**
   * Checks if ffmpeg is available on the system
   */
  async checkFfmpegAvailability(): Promise<boolean> {
    return new Promise((resolve) => {
      const ffmpeg = spawn('ffmpeg', ['-version']);
      ffmpeg.on('error', () => resolve(false));
      ffmpeg.on('exit', (code) => resolve(code === 0));
    });
  }
}
