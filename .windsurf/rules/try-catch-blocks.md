---
trigger: always_on
---

Do not catch errors just for logging them. Only add try/catch blocks if you actually want to change behavior on error. Otherwise, just let the exception bubble up and get noticed.
Do not try to proceed with arbitrary fallbacks either. No fallbacks, unless explicitly stated.