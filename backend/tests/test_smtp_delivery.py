"""_send_email against a real SMTP conversation: a small in-process server
speaks the protocol over a socket, so smtplib's actual behaviour (EHLO,
envelope, DATA, encodings) is exercised, not a mock of it."""
import email
import socket
import threading

import pytest

from app.core.config import settings
from app.services import notification_service as ns


class MiniSMTP:
    def __init__(self):
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(5)
        self.port = self.sock.getsockname()[1]
        self.messages = []  # (mail_from, rcpts, raw bytes)
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def _serve(self):
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            with conn:
                self._session(conn)

    def _session(self, conn):
        f = conn.makefile("rwb")

        def say(line):
            f.write(line.encode() + b"\r\n")
            f.flush()

        say("220 test ESMTP")
        mail_from, rcpts = None, []
        while True:
            line = f.readline()
            if not line:
                return
            text = line.decode(errors="replace").strip()
            cmd = text.upper()
            if cmd.startswith("EHLO") or cmd.startswith("HELO"):
                say("250 test")
            elif cmd.startswith("MAIL FROM"):
                mail_from = text.split(":", 1)[1].strip().strip("<>").split()[0].strip("<>")
                say("250 ok")
            elif cmd.startswith("RCPT TO"):
                rcpts.append(text.split(":", 1)[1].strip().strip("<>"))
                say("250 ok")
            elif cmd == "DATA":
                say("354 go")
                body = b""
                while True:
                    chunk = f.readline()
                    if chunk in (b".\r\n", b""):
                        break
                    body += chunk
                self.messages.append((mail_from, rcpts, body))
                mail_from, rcpts = None, []
                say("250 queued")
            elif cmd == "QUIT":
                say("221 bye")
                return
            else:
                say("250 ok")

    def close(self):
        self.sock.close()


@pytest.fixture()
def smtp(monkeypatch):
    server = MiniSMTP()
    monkeypatch.setattr(settings, "smtp_host", "127.0.0.1")
    monkeypatch.setattr(settings, "smtp_port", server.port)
    monkeypatch.setattr(settings, "smtp_use_tls", False)
    monkeypatch.setattr(settings, "smtp_username", None)
    monkeypatch.setattr(settings, "smtp_from", "alerts@example.test")
    yield server
    server.close()


def parse(raw):
    return email.message_from_bytes(raw)


def test_a_message_reaches_the_server_with_the_right_envelope_and_headers(smtp):
    ns._send_email("sara@example.test", "[CRITICAL] Weapon detected", "Camera entrance")

    (mail_from, rcpts, raw), = smtp.messages
    message = parse(raw)
    assert mail_from == "alerts@example.test"
    assert rcpts == ["sara@example.test"]
    assert message["Subject"] == "[CRITICAL] Weapon detected"
    assert message["To"] == "sara@example.test"
    assert message.get_payload().strip() == "Camera entrance"


def test_accented_text_survives_the_trip(smtp):
    ns._send_email("sara@example.test", "[CRITICAL] Arme détectée à l'accueil", "Caméra de l'entrée : alerte")

    message = parse(smtp.messages[0][2])
    assert str(email.header.make_header(email.header.decode_header(message["Subject"]))) == (
        "[CRITICAL] Arme détectée à l'accueil"
    )
    assert message.get_content_charset() == "utf-8"
    assert "Caméra de l'entrée" in message.get_payload(decode=True).decode("utf-8")


def test_an_unreachable_server_raises_so_the_caller_can_log_it(monkeypatch):
    dead = socket.socket()
    dead.bind(("127.0.0.1", 0))
    port = dead.getsockname()[1]
    dead.close()  # nothing listens here now
    monkeypatch.setattr(settings, "smtp_host", "127.0.0.1")
    monkeypatch.setattr(settings, "smtp_port", port)
    monkeypatch.setattr(settings, "smtp_use_tls", False)

    with pytest.raises(OSError):
        ns._send_email("sara@example.test", "x", "y")
