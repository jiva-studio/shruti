from difflib import SequenceMatcher

from airflow.decorators import task
from airflow.utils.email import send_email_smtp

from lectorium.transcripts.models.transcript import Transcript, TranscriptChunk


@task(
    task_display_name="📧 Send Transcript Saved Report")
def send_transcript_saved_report(
    track_id: str,
    language: str,
    transcript_original: Transcript,
    transcript_proofread: Transcript,
    show_diff: bool = False
) -> list[TranscriptChunk]:

    cell_style = "padding: 6px;"

    # ---------------------------------------------------------------------------- #
    #                                 Dependencies                                 #
    # ---------------------------------------------------------------------------- #

    def diff_strings(a: str, b: str) -> str:
        output = []
        matcher = SequenceMatcher(None, a, b)
        green = '<span style="color: green">'
        red = '<span style="color: red">'
        endgreen = '</span>'
        endred = '</span>'

        for opcode, a0, a1, b0, b1 in matcher.get_opcodes():
            if opcode == 'equal':
                output.append(a[a0:a1])
            elif opcode == 'insert':
                output.append(f'{green}{b[b0:b1]}{endgreen}')
            elif opcode == 'delete':
                output.append(f'{red}{a[a0:a1]}{endred}')
            elif opcode == 'replace':
                output.append(f'{green}{b[b0:b1]}{endgreen}')
                output.append(f'{red}{a[a0:a1]}{endred}')
        return ''.join(output)

    # ---------------------------------------------------------------------------- #
    #                                     Steps                                    #
    # ---------------------------------------------------------------------------- #

    table_rows = []
    for idx, original_block in enumerate(transcript_original["blocks"]):
        profread_block = (
            transcript_proofread["blocks"][idx]
            if idx < len(transcript_proofread["blocks"])
            else {}
        )
        time_has_changed = (
            original_block.get("start", "") != profread_block.get("start", "")
            or original_block.get("end", "") != profread_block.get("end", "")
        )

        table_rows.append(
            f"<tr>" +
            f"<td style='{cell_style}'>{idx}</td>" +
            f"<td style='{cell_style}'>{original_block.get("start", "")} - {original_block.get("end", "")}</td>" +
           (f"<td style='{cell_style}'>{profread_block.get("start", "")} - {profread_block.get("end", "")}</td>" if time_has_changed else f"<td></td>") +
           (f"<td style='{cell_style}'>{diff_strings(original_block.get("text", ""), profread_block.get("text", ""))}</td>" if show_diff else
            f"<td style='{cell_style}'>{original_block.get("text", "")}<br>{profread_block.get("text", "")}</td>") +
            f"</tr>"
        )

    # ---------------------------------------------------------------------------- #
    #                                    Output                                    #
    # ---------------------------------------------------------------------------- #

    send_email_smtp(
        to=["alerts@akdasa.studio"], # TODO: Change to variable
        conn_id="alert_email",
        subject="New transcript saved",
        html_content=f"""
        <h2>Transcript saved</h2>
            New transcript has been saved for track
            <code>{track_id}</code> on <code>{language}</code> language.
            <br><br>

        <h3>Transcript text</h3>
            <table border="1">
                <tr>
                    <th style='{cell_style}'>Block</th>
                    <th style='{cell_style}'>Time Orig</th>
                    <th style='{cell_style}'>Time Edit</th>
                    <th style='{cell_style}'>Text</th>
                </tr>
                {"".join(table_rows)}
            </table>
        """,
    )

