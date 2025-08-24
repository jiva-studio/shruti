from beam import CloudBucket, CloudBucketConfig, Image, QueueDepthAutoscaler, task_queue


mount_path = "./bucket"
files = CloudBucket(
    name="lectorium-prod",
    mount_path=mount_path,
    config=CloudBucketConfig(
        access_key="S3_ACCESS_KEY",
        secret_key="S3_SECRET_KEY",
        endpoint="https://s3.eu-central-2.wasabisys.com",
        region="eu-central-2"
    ),
)


@task_queue(
    name="audio-enhance-2",
    cpu=2,
    memory="4Gi",
    gpu="T4",
    image=Image(
        base_image="pytorch/pytorch:2.5.1-cuda12.4-cudnn9-devel",
        python_version="python3.11",
        python_packages=[
            "ninja",
            "packaging",
            "librosa",
            "soundfile",
            "pyyaml",
            "argparse",
            "tensorboard",
            "pesq",
            "einops",
            "pydub",
            "torch==2.5.1",
            "torchaudio==2.5.1",
            "numpy==1.26.4",
            "setuptools==65.5.0",
        ],
    ).add_commands([
        "apt update",
        "apt install git ffmpeg -y",
        "git clone https://github.com/state-spaces/mamba.git && cd mamba && git checkout a07faffa36a7b89e754b5de972418475bcdd77b6 && pip install .",
    ]),
    workers=2,
    keep_warm_seconds=60,
    volumes=[files],
    autoscaler=QueueDepthAutoscaler(max_containers=4, tasks_per_container=2),
)
def handle(context, **inputs):
    import torch
    import yaml
    import librosa
    import numpy as np
    import soundfile as sf
    import subprocess, tempfile
    import json

    from os.path import join
    from models.stfts import mag_phase_stft, mag_phase_istft
    from models.generator import SEMamba
    from pydub import AudioSegment, silence
    from pathlib import Path

    # ---------------------------------------------------------------------------- #
    #                                Input Arguments                               #
    # ---------------------------------------------------------------------------- #

    bucket_input_key  = inputs.get("input", None)
    bucket_output_key = inputs.get("output", None)
    bucket_meta_key   = inputs.get("meta", None)
    input_file_path   = join(files.mount_path, bucket_input_key)

    print(f"input:  {bucket_input_key}")
    print(f"output: {bucket_output_key}")
    print(f"meta:   {bucket_meta_key}")

    # ---------------------------------------------------------------------------- #
    #                                 Model Config                                 #
    # ---------------------------------------------------------------------------- #

    device      = "cuda"
    ckpt_path   = "checkpoints/vd.pth"
    config_path = "recipes/SEMamba_advanced.yaml"
    with open(config_path, 'r') as f: 
        cfg = yaml.safe_load(f)

    # ---------------------------------------------------------------------------- #
    #                                  Load Model                                  #
    # ---------------------------------------------------------------------------- #

    model  = SEMamba(cfg).to(device)
    model.load_state_dict(torch.load(ckpt_path, map_location=device)["generator"])
    model.eval()


    with (
        torch.no_grad(),
        tempfile.TemporaryDirectory() as td
    ):
        # load file & resample if requied
        print("Loading audio...")
        wav, orig_sr = librosa.load(input_file_path, sr=None)
        if orig_sr != 16000:
            wav = librosa.resample(wav, orig_sr=orig_sr, target_sr=16000)
        x = torch.from_numpy(wav).float().to(device)
        norm = torch.sqrt(len(x)/torch.sum(x**2))
        x = (x * norm)

        # split into 4s segments (64000 samples)
        segment_len = 4 * 16000
        chunks      = x.split(segment_len)
        enhanced_chunks = []

        # process every chunk
        print("Processing chunks...")
        for chunk in chunks:
            if len(chunk) < segment_len:
                pad   = (torch.randn(segment_len - len(chunk), device=chunk.device) * 1e-4)
                chunk = torch.cat([chunk, pad])
            chunk = chunk.unsqueeze(0)

            amp, pha, _   = mag_phase_stft(chunk, 400, 100, 400, 0.3)
            amp2, pha2, _ = model(amp, pha)
            out           = mag_phase_istft(amp2, pha2, 400, 100, 400, 0.3)
            out           = (out / norm).squeeze(0)
            enhanced_chunks.append(out)

        out = torch.cat(enhanced_chunks)[:len(x)].cpu().numpy()  # trim padding

        # back to original rate
        print("Post-processing...")
        if orig_sr != 16000:
            out = librosa.resample(out, orig_sr=16000, target_sr=orig_sr)

        # normalize
        peak = np.max(np.abs(out))
        if peak > 0.05:
            out = out / peak * 0.85

        # ---------------------------------------------------------------------------- #
        #                                 Write Result                                 #
        # ---------------------------------------------------------------------------- #

        # write temp file file
        print("Saving...")
        tmp_name = Path(td) / f"{context.task_id}.mp3"
        sf.write(tmp_name, out, orig_sr)

        # ---------------------------------------------------------------------------- #
        #                               Silence Detection                              #
        # ---------------------------------------------------------------------------- #

        print("Detecting silence...")
        audio    = AudioSegment.from_file(tmp_name)
        silences = silence.detect_silence(
            audio,
            min_silence_len=1000,  # 1 second
            silence_thresh=audio.dBFS - 14  # 14 dB above avg noise
        )

        # ---------------------------------------------------------------------------- #
        #                             Merge Silence Blocks                             #
        # ---------------------------------------------------------------------------- #

        merged_silences = []
        gap_threshold = 3000  # milliseconds
        for start, end in silences:
            if not merged_silences:
                merged_silences.append([start, end])
            else:
                last_start, last_end = merged_silences[-1]
                if start - last_end < gap_threshold:
                    merged_silences[-1][1] = end
                else:
                    merged_silences.append([start, end])

        # ---------------------------------------------------------------------------- #
        #                   Replace Silence Block From Original File                   #
        # ---------------------------------------------------------------------------- #

        min_silence_len = 5000
        if merged_silences and merged_silences[0][1] > min_silence_len:
            print("Replacing silenced segment...")
            start, end = merged_silences[0]
            print(f"First silence block: {start/1000:.3f}s → {end/1000:.3f}s")

            first_part   = AudioSegment.from_file(input_file_path)[:end]
            raw_wav      = Path(td) / "first.wav"
            denoised_mp3 = Path(td) / "first_denoised.mp3"
            first_part.export(raw_wav, format="wav")

            subprocess.run([
                "ffmpeg", "-y", "-i", str(raw_wav),
                "-af", "afftdn=nf=-25",  # nf = noise floor in dB
                "-c:a", "libmp3lame", 
                "-b:a", "128k",
                str(denoised_mp3)
            ], check=True)
            first_part = AudioSegment.from_file(denoised_mp3)

            second_part = AudioSegment.from_file(tmp_name)[end:]
            final_audio = first_part + second_part
            final_audio.export(tmp_name, format="mp3")
        else:
            print("No silence detected")

        # ---------------------------------------------------------------------------- #
        #                                 Final Process                                #
        # ---------------------------------------------------------------------------- #

        print("Recoding...")
        final_file = Path(td) / "final.mp3"
        subprocess.run([
            "ffmpeg", "-y",
            "-i",      str(tmp_name),
            "-ac",     "1",  # convert to mono
            "-af",     "dynaudnorm=f=150:g=5:m=15:s=10,alimiter=limit=-1.5dB",  # dynamic normalization + limiter
            "-c:a",    "libmp3lame",
            "-b:a",    "128k",  # set bitrate
            str(final_file)
        ], check=True)

        # ---------------------------------------------------------------------------- #
        #                                Copy to Bucket                                #
        # ---------------------------------------------------------------------------- #

        print("Saving to bucket...")
        with open(final_file, 'rb') as source_file:
            with open(join(files.mount_path, bucket_output_key), 'wb') as dest_file:
                while True:
                    chunk = source_file.read(8192)
                    if not chunk:
                        break
                    dest_file.write(chunk)

        # ensure parent directories exist for the meta file
        Path(join(files.mount_path, bucket_meta_key)).parent.mkdir(parents=True, exist_ok=True)
        with open(join(files.mount_path, bucket_meta_key), 'wb') as dest_file:
            meta = {
                "firstSegment": merged_silences[0][1] if merged_silences and merged_silences[0][1] > min_silence_len else None,
            }
            dest_file.write(json.dumps(meta, ensure_ascii=False).encode("utf-8"))


    # ---------------------------------------------------------------------------- #
    #                                     Done                                     #
    # ---------------------------------------------------------------------------- #

    return { "status": "ok" }
