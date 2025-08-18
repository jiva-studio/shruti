import re
import os
from datetime import timedelta
from elevenlabs.client import ElevenLabs
from elevenlabs import save
from pydub import AudioSegment

# Initialize ElevenLabs client
client = ElevenLabs(api_key="")

# Function to parse time string (mm:ss) to milliseconds
def parse_time(time_str):
    minutes, seconds = map(int, time_str.split(':'))
    return (minutes * 60 + seconds) * 1000

# Function to generate audio for a text segment
def generate_segment_audio(text, output_file, voice_id="gedzfqL7OGdPbwm0ynTP"):
    audio = client.text_to_speech.convert(
        text=text,
        voice_id=voice_id,
        model_id="eleven_multilingual_v2",
        output_format="mp3_44100_128"
    )
    save(audio, output_file)

# Function to combine audio segments with silences
def combine_segments(segments, output_file):
    combined = AudioSegment.silent(duration=0)
    
    for i, (start_time, text, audio_file) in enumerate(segments):
        # Load the generated audio
        segment_audio = AudioSegment.from_mp3(audio_file)
        
        # Calculate silence duration before this segment
        if i == 0:
            silence_duration = start_time
        else:
            prev_end = segments[i-1][0] + len(AudioSegment.from_mp3(segments[i-1][2]))
            silence_duration = start_time - prev_end
            
        # Add silence if needed
        if silence_duration > 0:
            combined += AudioSegment.silent(duration=silence_duration)
            
        # Add the audio segment
        combined += segment_audio
    
    # Export the final audio
    combined.export(output_file, format="mp3")

def main():
    # Your transcript
    transcript = """
(0:01) Итак
(0:03) снова, слово ришикеша
(0:06) здесь используется снова
(0:11) В начале также
(0:13) ришикеша панти джанам.
(0:20) Кришна снова обозначается как ришикеша.
(0:27) Как мы уже объясняли несколько раз, бхакти означает
(0:39) вся программа преданного служения означает
    """
    
    # Create output directory
    output_dir = "audio_segments"
    os.makedirs(output_dir, exist_ok=True)
    
    # Parse transcript into segments
    segments = []
    pattern = r'\((\d+:\d+)\)\s+([^\(]+)(?=\n|\Z)'
    
    for match in re.finditer(pattern, transcript.strip()):
        time_str = match.group(1)
        text = match.group(2).strip()
        start_time = parse_time(time_str)
        print(text)
        
        # Generate audio for this segment
        segment_file = os.path.join(output_dir, f"segment_{len(segments)}.mp3")
        generate_segment_audio(text, segment_file)
        
        segments.append((start_time, text, segment_file))
    
    # Combine all segments
    final_output = "final_output.mp3"
    combine_segments(segments, final_output)
    
    print(f"Generated final audio file: {final_output}")

if __name__ == "__main__":
    main()