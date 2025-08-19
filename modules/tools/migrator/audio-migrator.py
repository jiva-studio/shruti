import subprocess

TOKEN = "oXhBV2VC6nnwDMRG9AQz2t9KENoKuLpghGFXXIwrW4Ky2bp_lrPVgQTx9obRvqSayAdfUC4d5gDM7MqFKi9Smg=="

ids = [
    # "aeaijbzva",
    # "akgajbzva",
    # "aotxjbzva",
    # "barjlfaku",
    # "ciwisbxuv",
    # "emzdrsalo",
    # "gxqhkrdps",
    # "hksyoumrp",
    # "iluiztsoj",
    # "jutiwikhp",
    # "kyzteejfb",
    # "ljxndpbfe",
    # "msdxtozpq",
    # "nhydancts",
    # "pqakcovhq",
    # "rtbmxopmr",
    # "szhnvsqcb",
    # "urvjgqjls",
    # "vfhmqcetm",
    # "xpboycift",
    # "yclwmtpoa",
    # "zdkjfslwa",
    "uyutgqjls"
]

for track_id in ids:
    cmd = [
        "curl", "-X", "POST", "https://audio-enhance-2-83b00eb-v25.app.beam.cloud",
        "-H", "Connection: keep-alive",
        "-H", "Content-Type: application/json",
        "-H", f"Authorization: Bearer {TOKEN}",
        "-d", f"""{{
            "input":  "library/tracks/{track_id}/audio/original.mp3",
            "output": "library/tracks/{track_id}/audio/clean.mp3",
            "meta":   "library/tracks/{track_id}/artifacts/audio/clean.json"
        }}"""
    ]
    print(f"Processing {track_id}...")
    subprocess.run(cmd)