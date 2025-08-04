import {
  Injectable,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { Readable, PassThrough } from 'stream';
import { spawn } from 'child_process';

@Injectable()
export class AudioProcessingService {
  private readonly logger = new Logger(AudioProcessingService.name);

  /**
   * Extracts a segment from an MP3 stream using ffmpeg
   * @param inputStream - The input MP3 stream
   * @param timeStart - Start time in seconds
   * @param timeEnd - End time in seconds
   * @returns A stream containing the extracted MP3 segment
   */
  async extractSegment(
    inputStream: Readable,
    timeStart: number,
    timeEnd: number,
  ): Promise<PassThrough> {
    return new Promise((resolve, reject) => {
      const outputStream = new PassThrough();
      const duration = timeEnd - timeStart;

      // Use ffmpeg to extract the segment
      const ffmpeg = spawn(
        'ffmpeg',
        [
          '-i',
          'pipe:0', // Input from stdin
          '-ss',
          timeStart.toString(), // Start time
          '-t',
          duration.toString(), // Duration
          '-c',
          'copy', // Copy codec (no re-encoding for speed)
          '-f',
          'mp3', // Output format
          'pipe:1', // Output to stdout
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
        }
      });

      // Connect streams
      inputStream.pipe(ffmpeg.stdin);
      ffmpeg.stdout.pipe(outputStream);

      // Log stderr for debugging
      ffmpeg.stderr.on('data', (data) => {
        this.logger.debug(`FFmpeg stderr: ${data.toString()}`);
      });

      // Handle input stream errors
      inputStream.on('error', (error) => {
        this.logger.error(`Input stream error: ${error.message}`);
        ffmpeg.kill();
        reject(new InternalServerErrorException('Input stream error'));
      });

      // Return the output stream immediately
      resolve(outputStream);
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
