> Adapted from the upstream `webapp-testing` skill (Apache-2.0); the changes are listed in `SOURCE.md`.

# Example Playwright scripts (Python)

Upstream shipped these as `examples/*.py`. They are reference text here: copy the one you need into the workspace
(for example `.skill-helpers/check_page.py`), change the URL and selectors, and run it with your normal command
permission, on its own or through the server helper in `with-server-helper.md`.

They need the `playwright` Python package and a Playwright browser; see "Missing tools" in `SKILL.md`. Output files
go to `.skill-helpers/output` in the project, or to the folder the project already uses for test output.

When the managed Playwright integration is granted to you, you usually need none of these: its tools navigate,
read the page, click, type, take screenshots and return console messages directly.

All three wait for a condition (a load state or an element), not for a fixed time. Replace the example selectors
with what the next step actually needs.

## Discovering buttons, links and inputs on a page

```python
from pathlib import Path

from playwright.sync_api import sync_playwright

# Example: Discovering buttons and other elements on a page

OUTPUT_DIR = Path('.skill-helpers') / 'output'
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()

    # Navigate to page and wait for it to fully load
    page.goto('http://localhost:5173')
    page.wait_for_load_state('networkidle')

    # Discover all buttons on the page
    buttons = page.locator('button').all()
    print(f"Found {len(buttons)} buttons:")
    for i, button in enumerate(buttons):
        text = button.inner_text() if button.is_visible() else "[hidden]"
        print(f"  [{i}] {text}")

    # Discover links
    links = page.locator('a[href]').all()
    print(f"\nFound {len(links)} links:")
    for link in links[:5]:  # Show first 5
        text = link.inner_text().strip()
        href = link.get_attribute('href')
        print(f"  - {text} -> {href}")

    # Discover input fields
    inputs = page.locator('input, textarea, select').all()
    print(f"\nFound {len(inputs)} input fields:")
    for input_elem in inputs:
        name = input_elem.get_attribute('name') or input_elem.get_attribute('id') or "[unnamed]"
        input_type = input_elem.get_attribute('type') or 'text'
        print(f"  - {name} ({input_type})")

    # Take screenshot for visual reference
    screenshot = OUTPUT_DIR / 'page_discovery.png'
    page.screenshot(path=str(screenshot), full_page=True)
    print(f"\nScreenshot saved to {screenshot}")

    browser.close()
```

## Automating a local static HTML file

```python
from pathlib import Path

from playwright.sync_api import sync_playwright

# Example: Automating interaction with static HTML files using file:// URLs

OUTPUT_DIR = Path('.skill-helpers') / 'output'
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# as_uri() builds a correct file URL on every platform, including C:\ paths on Windows.
file_url = Path('path/to/your/file.html').resolve().as_uri()

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1920, 'height': 1080})

    # Navigate to local HTML file
    page.goto(file_url)

    # Take screenshot
    page.screenshot(path=str(OUTPUT_DIR / 'static_page.png'), full_page=True)

    # Interact with elements
    page.click('text=Click Me')
    page.fill('#name', 'John Doe')
    page.fill('#email', 'john@example.com')

    # Submit form, then wait for what the submit should show (replace the selector)
    page.click('button[type="submit"]')
    page.wait_for_selector('#result')

    # Take final screenshot
    page.screenshot(path=str(OUTPUT_DIR / 'after_submit.png'), full_page=True)

    browser.close()

print("Static HTML automation completed!")
```

## Capturing console logs during automation

```python
from pathlib import Path

from playwright.sync_api import sync_playwright

# Example: Capturing console logs during browser automation

url = 'http://localhost:5173'  # Replace with your URL

OUTPUT_DIR = Path('.skill-helpers') / 'output'
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

console_logs = []

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1920, 'height': 1080})

    # Set up console log capture
    def handle_console_message(msg):
        console_logs.append(f"[{msg.type}] {msg.text}")
        print(f"Console: [{msg.type}] {msg.text}")

    page.on("console", handle_console_message)

    # Navigate to page
    page.goto(url)
    page.wait_for_load_state('networkidle')

    # Interact with the page (triggers console logs), then wait for what the click should show
    page.click('text=Dashboard')
    page.wait_for_selector('h1')  # Replace with the element the Dashboard view renders

    browser.close()

# Save console logs to file
log_path = OUTPUT_DIR / 'console.log'
log_path.write_text('\n'.join(console_logs), encoding='utf-8')

print(f"\nCaptured {len(console_logs)} console messages")
print(f"Logs saved to: {log_path}")
```
