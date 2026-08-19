import unittest

import numpy as np

import feature_infer


class FakeStreamingFeatures:
    def __init__(self):
        self.calls = []

    def __call__(self, audio):
        self.calls.append(np.array(audio, copy=True))
        return feature_infer.STREAM_FRAME_SAMPLES

    def get_features(self, frame_count):
        return np.ones((1, frame_count, feature_infer.FEATURE_DIM), dtype=np.float32)


class FeatureInferStreamingTests(unittest.TestCase):
    def make_infer(self):
        instance = feature_infer.FeatureInfer.__new__(feature_infer.FeatureInfer)
        instance.features = FakeStreamingFeatures()
        instance.samples_seen = 0
        instance.sample_rate = feature_infer.DEFAULT_SAMPLE_RATE
        instance.frame_samples = feature_infer.STREAM_FRAME_SAMPLES
        instance.cooldown_ms = 0
        instance.last_detect_ts = {}
        instance.last_global_detect_ts = 0.0
        instance.pending_detection = None
        instance.pending_detection_frames = 0
        instance.detection_confirmation_ms = feature_infer.DETECTION_CONFIRMATION_MS
        return instance

    def test_preprocess_advances_quiet_audio_before_inference_is_ready(self):
        instance = self.make_infer()
        quiet_frame = np.zeros(feature_infer.STREAM_FRAME_SAMPLES, dtype=np.int16)

        self.assertIsNone(instance.preprocess(quiet_frame))
        self.assertEqual(len(instance.features.calls), 1)

        instance.samples_seen = feature_infer.MIN_READY_SAMPLES - feature_infer.STREAM_FRAME_SAMPLES
        window = instance.preprocess(quiet_frame)
        self.assertEqual(window.shape, (feature_infer.WINDOW_FRAMES, feature_infer.FEATURE_DIM))

    def test_arbitration_prefers_the_specific_phrase_over_its_short_alias(self):
        instance = self.make_infer()
        anna = {"model": "Anna", "score": 0.94, "threshold": 0.68, "eligible": True}
        hey_anna = {"model": "Hey Anna", "score": 0.75, "threshold": 0.57, "eligible": True}

        self.assertIsNone(instance.update_detection_candidate([anna]))
        self.assertIsNone(instance.update_detection_candidate([anna, hey_anna]))
        detection = instance.update_detection_candidate([anna, hey_anna])

        self.assertIsNotNone(detection)
        self.assertEqual(detection["model"], "Hey Anna")

    def test_single_frame_score_spike_does_not_trigger_a_wake(self):
        instance = self.make_infer()
        spike = {"model": "Anna", "score": 0.99, "threshold": 0.68, "eligible": True}

        self.assertIsNone(instance.update_detection_candidate([spike]))
        self.assertIsNone(instance.update_detection_candidate([]))

    def test_confirmation_window_is_runtime_tunable(self):
        instance = self.make_infer()
        instance.detection_confirmation_ms = 320
        candidate = {"model": "Anna", "score": 0.99, "threshold": 0.68, "eligible": True}

        self.assertIsNone(instance.update_detection_candidate([candidate]))
        self.assertIsNone(instance.update_detection_candidate([candidate]))
        self.assertIsNone(instance.update_detection_candidate([candidate]))
        detection = instance.update_detection_candidate([candidate])

        self.assertIsNotNone(detection)
        self.assertEqual(detection["model"], "Anna")
        self.assertIsNone(instance.update_detection_candidate([]))


if __name__ == "__main__":
    unittest.main()
