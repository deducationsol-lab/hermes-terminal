"""Stdlib unittest for the sim-desk -> hermes-terminal ingest mapping.

Asserts that :func:`event_to_payload` produces payloads matching the /ingest
contract (channel/level/message/meta shape) and that :class:`HermesClient` is
fail-soft: posting with no server running does not raise.

Run with:
    python3 -m unittest discover -s examples/sim-desk -p 'test_*.py'
"""

from __future__ import annotations

import unittest

from hermes_client import (
    LEVEL_ERROR,
    LEVEL_INFO,
    LEVEL_WARN,
    HermesClient,
    event_to_payload,
    level_for_event,
)


class EventToPayloadTests(unittest.TestCase):
    def _assert_payload_shape(self, payload: dict, channel: str, level: str) -> None:
        # channel is the configured non-empty channel
        self.assertEqual(payload["channel"], channel)
        self.assertIsInstance(payload["channel"], str)
        self.assertTrue(len(payload["channel"]) > 0)
        # message is a non-empty string
        self.assertIsInstance(payload["message"], str)
        self.assertTrue(len(payload["message"]) > 0)
        # level is the expected mapped value
        self.assertEqual(payload["level"], level)
        self.assertIn(payload["level"], (LEVEL_INFO, LEVEL_WARN, LEVEL_ERROR))
        # meta is a dict containing the generic keys
        meta = payload["meta"]
        self.assertIsInstance(meta, dict)
        for key in ("agent", "kind", "symbol", "reason", "data"):
            self.assertIn(key, meta)
        self.assertIsInstance(meta["data"], dict)

    def test_normal_activity_maps_to_info(self) -> None:
        event = {
            "agent": "scout",
            "kind": "candidate",
            "symbol": "SIM-ABC001",
            "reason": "new synthetic candidate",
            "data": {"liquidity": 5000.0},
        }
        payload = event_to_payload(event, "desk")
        self._assert_payload_shape(payload, "desk", LEVEL_INFO)

    def test_losing_halt_reject_maps_to_warn(self) -> None:
        for kind in ("loss", "halt", "reject", "skip"):
            with self.subTest(kind=kind):
                event = {
                    "agent": "risk",
                    "kind": kind,
                    "symbol": "SIM-XYZ002",
                    "reason": "generic_reason",
                    "data": {"drawdown": 0.3},
                }
                payload = event_to_payload(event, "desk")
                self._assert_payload_shape(payload, "desk", LEVEL_WARN)

    def test_hard_failure_maps_to_error(self) -> None:
        for kind in ("error", "failure", "fatal"):
            with self.subTest(kind=kind):
                event = {
                    "agent": "executor",
                    "kind": kind,
                    "symbol": "SIM-ERR003",
                    "reason": "hard_failure",
                    "data": {"detail": "synthetic"},
                }
                payload = event_to_payload(event, "desk")
                self._assert_payload_shape(payload, "desk", LEVEL_ERROR)

    def test_explicit_level_wins(self) -> None:
        event = {"agent": "desk", "kind": "candidate", "level": "warn", "data": {}}
        self.assertEqual(level_for_event(event), LEVEL_WARN)

    def test_custom_channel_is_respected(self) -> None:
        event = {"agent": "scout", "kind": "candidate", "data": {}}
        payload = event_to_payload(event, "my-channel")
        self.assertEqual(payload["channel"], "my-channel")

    def test_message_synthesized_when_absent(self) -> None:
        event = {"agent": "analyst", "kind": "enter", "symbol": "SIM-Q", "data": {}}
        payload = event_to_payload(event, "desk")
        self.assertIn("analyst", payload["message"])
        self.assertIn("SIM-Q", payload["message"])

    def test_meta_contains_data_dict(self) -> None:
        event = {"agent": "scout", "kind": "candidate", "data": {"price": 1.23}}
        payload = event_to_payload(event, "desk")
        self.assertEqual(payload["meta"]["data"], {"price": 1.23})


class FailSoftTests(unittest.TestCase):
    def test_post_without_server_does_not_raise(self) -> None:
        # Point at a port where nothing is listening; must fail soft.
        client = HermesClient(
            base_url="http://127.0.0.1:1",
            channel="desk",
            timeout=0.5,
            quiet=True,
        )
        result = client.post({"channel": "desk", "message": "probe"})
        self.assertFalse(result)
        self.assertGreaterEqual(client.failures, 1)

    def test_emit_without_server_does_not_raise(self) -> None:
        client = HermesClient(
            base_url="http://127.0.0.1:1",
            channel="desk",
            timeout=0.5,
            quiet=True,
        )
        event = {"agent": "scout", "kind": "candidate", "data": {}}
        result = client.emit(event)
        self.assertFalse(result)


if __name__ == "__main__":
    unittest.main()
