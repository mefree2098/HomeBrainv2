"""Offline acceptance checks for the installed training and inference runtime.

Run with server/.wakeword-venv/bin/python. No microphone, speakers, network
requests or home controls are used. Pretrained AudioFeatures assets must already
be installed. Set HOMEBRAIN_SECURITY_SMOKE_PIPER_MODEL to test a cached voice.
"""

import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import wave

import numpy as np
import onnx
import onnxruntime as ort
from openwakeword.utils import AudioFeatures
import torch

spec = importlib.util.spec_from_file_location("homebrain_training", Path(__file__).with_name("train_wake_word.py"))
training = importlib.util.module_from_spec(spec)
spec.loader.exec_module(training)


class WakeWordRuntimeTests(unittest.TestCase):
    def test_training_and_onnx_export_preserve_predictions(self):
        torch.manual_seed(42)
        trainer = training.WakeWordTrainer((16, 96), batch_size=2, learning_rate=0.001)
        features = np.random.default_rng(42).normal(size=(4, 16, 96)).astype(np.float32)
        dataset = torch.utils.data.TensorDataset(torch.from_numpy(features), torch.tensor([0., 1., 0., 1.]))
        loader = torch.utils.data.DataLoader(dataset, batch_size=2)
        loss, accuracy = trainer.run_epoch(loader, train=True)
        self.assertTrue(np.isfinite(loss))
        self.assertTrue(0 <= accuracy <= 1)
        trainer.model.eval()
        with torch.no_grad():
            expected = trainer.model(torch.from_numpy(features[:1]).to(trainer.device)).cpu().numpy()
        with tempfile.TemporaryDirectory() as directory:
            model = Path(directory) / "security-smoke.onnx"
            trainer.export_onnx(model)
            onnx.checker.check_model(onnx.load(model))
            session = ort.InferenceSession(str(model), providers=["CPUExecutionProvider"])
            actual = session.run(None, {"audio": features[:1]})[0]
            np.testing.assert_allclose(actual, expected, rtol=1e-4, atol=1e-5)

    def test_real_audio_feature_models_accept_silent_frames(self):
        features = AudioFeatures(inference_framework="onnx", ncpu=1)
        for _ in range(32):
            features(np.zeros(1280, dtype=np.int16))
        result = features.get_features(16)
        self.assertEqual(result.shape, (1, 16, 96))
        self.assertTrue(np.isfinite(result).all())

    @unittest.skipUnless(os.environ.get("HOMEBRAIN_SECURITY_SMOKE_PIPER_MODEL"), "cached Piper voice not selected")
    def test_cached_piper_voice_synthesizes_offline(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "speech.wav"
            subprocess.run([
                str(Path(sys.executable).with_name("piper")), "--model",
                os.environ["HOMEBRAIN_SECURITY_SMOKE_PIPER_MODEL"], "--output_file", str(output)
            ], input="HomeBrain security validation.\n", text=True, check=True, timeout=90,
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            with wave.open(str(output)) as audio:
                self.assertGreater(audio.getnframes(), 100)
                self.assertGreaterEqual(audio.getframerate(), 16000)


if __name__ == "__main__":
    unittest.main()
