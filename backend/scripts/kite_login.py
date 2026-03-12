from __future__ import annotations

import webbrowser

from backend.config import CONFIG


def main() -> None:
    login_url = "http://127.0.0.1:8000/api/v1/auth/kite/login"
    print("Open this URL if the browser does not launch automatically:")
    print(login_url)
    print("")
    print("Kite app redirect URL must be set to:")
    print(CONFIG.zerodha.redirect_url)
    webbrowser.open(login_url)


if __name__ == "__main__":
    main()
