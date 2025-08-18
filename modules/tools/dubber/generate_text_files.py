import json
from pathlib import Path

def generate_utterances_script(
    input_file_path: str,
    output_file_path: str,
):
  with open(input_file_path, "r", encoding="utf-8") as f:
      data = json.load(f)

  # Build the lines
  lines = []
  for utt in data.get("results", {}).get("utterances", []):
      start = utt.get("start")
      transcript = utt.get("transcript", "").strip()
      if start is not None and transcript:
          lines.append(f"({start}) {transcript}")

  # Join into one line
  output_text = " ".join(lines)

  # Save to a text file
  with open(output_file_path, "w", encoding="utf-8") as f:
      f.write(output_text)



def generate_proofread_script(
    input_file_path: str,
    output_file_path: str,
):
  with open(input_file_path, "r", encoding="utf-8") as f:
      data = json.load(f)

  blocks = data.get("blocks", [])

  def get_text(text_field):
      if isinstance(text_field, str): return text_field
      if isinstance(text_field, list): return " ".join(text_field)

  # Build merged string
  parts = []
  for block in blocks:
      start = block.get("start")
      text = get_text(block.get("text", "")).strip()
      parts.append(f"({start}) {text}")

  result = " ".join(parts)

  with open(output_file_path, "w", encoding="utf-8") as f:
      f.write(result)


# ---------------------------------------------------------------------------- #
#                                   Generate                                   #
# ---------------------------------------------------------------------------- #

generate_utterances_script("./input/deepgram_response.json", "./output/utterances.txt")
generate_proofread_script("./input/en.json", "./output/proofread.txt")
