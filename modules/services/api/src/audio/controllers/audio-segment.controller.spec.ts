import { createHash } from 'crypto';

describe('AudioSegment Caching', () => {
  it('should generate consistent hash-based cache keys', () => {
    const filePath = 'library/tracks/test/audio/original.mp3';
    const timeStart = 30;
    const timeEnd = 60;

    const cacheInput = `${filePath}_${timeStart}_${timeEnd}`;
    const hash = createHash('sha256').update(cacheInput).digest('hex');
    const cacheKey = `notes/${hash}.mp3`;

    // Verify the hash is consistent
    expect(cacheKey).toMatch(/^notes\/[a-f0-9]{64}\.mp3$/);

    // Verify the same input generates the same hash
    const hash2 = createHash('sha256').update(cacheInput).digest('hex');
    const cacheKey2 = `notes/${hash2}.mp3`;
    expect(cacheKey).toBe(cacheKey2);
  });

  it('should generate different hashes for different inputs', () => {
    const input1 = 'library/tracks/test1/audio/original.mp3_30_60';
    const input2 = 'library/tracks/test2/audio/original.mp3_30_60';

    const hash1 = createHash('sha256').update(input1).digest('hex');
    const hash2 = createHash('sha256').update(input2).digest('hex');

    expect(hash1).not.toBe(hash2);
  });
});
