from airflow.decorators import task


@task(task_display_name="📢 PyAnnoteAi: Get Speaker Segments ⤴️")
def pyannoteai_get_segments(
  data: dict,
  speaker_id: int,
) -> list[tuple[int, int]]:
  segments_result   = []
  segments_original = data['output']['diarization']
  speaker_id         = "SPEAKER_" + str(speaker_id - 1).zfill(2)

  segments_group_current = []
  for segment in segments_original:
    if segment['speaker'] == speaker_id:
      segments_group_current.append((segment['start'], segment['end']))
    else:
      if segments_group_current:
        segments_result.append(segments_group_current)
        segments_group_current = []
      segments_group_current = []
  if segments_group_current:
    segments_result.append(segments_group_current)

  return segments_result
