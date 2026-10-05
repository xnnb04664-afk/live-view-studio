from pathlib import Path
import re
import xml.etree.ElementTree as ET

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
APP_URL = "http://127.0.0.1:54321/"
SITE_URL = "http://127.0.0.1:54322/"
CJK = re.compile(r"[\u3400-\u9fff]+")


def assert_no_cjk(text: str, allowed: tuple[str, ...] = ()) -> None:
    for item in allowed:
        text = text.replace(item, "")
    remaining = [
        text[max(0, match.start() - 28):match.end() + 28].encode("unicode_escape").decode("ascii")
        for match in CJK.finditer(text)
    ]
    assert not remaining, f"Untranslated Chinese text: {remaining}"


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1440, "height": 1000})
    app = context.new_page()
    app_errors: list[str] = []
    app.on("pageerror", lambda error: app_errors.append(str(error)))
    app.on("console", lambda message: app_errors.append(f"console {message.type}: {message.text}") if message.type == "error" else None)
    app.add_init_script("""
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
        getUserMedia: async () => { throw new DOMException('Test camera permission denied', 'NotAllowedError'); },
        enumerateDevices: async () => [],
        addEventListener: () => {},
        removeEventListener: () => {}
      }});
    """)
    app.add_init_script("""
      const directoryKey = 'live-view-studio:test-photo-directory';
      const defaultDirectory = 'C:/Users/Playwright/Pictures/Default';
      let isFullscreen = false;
      window.desktop = {
        window: {
          getState: async () => ({ isFullscreen, isMaximized: false, isAlwaysOnTop: false }),
          setFullscreen: async (enabled) => { isFullscreen = Boolean(enabled); return isFullscreen; }
        },
        getSnapshotDirectory: async () => localStorage.getItem(directoryKey) || defaultDirectory,
        chooseSnapshotDirectory: async () => {
          const directory = 'C:/Users/Playwright/Pictures/Chosen';
          localStorage.setItem(directoryKey, directory);
          return directory;
        },
        resetSnapshotDirectory: async () => {
          localStorage.removeItem(directoryKey);
          return defaultDirectory;
        }
      };
    """)
    app.goto(APP_URL, wait_until="networkidle")
    app.wait_for_timeout(750)
    if app.locator("h1").count() == 0:
        print("APP_DEBUG", app.locator("body").inner_text(), app_errors, app.content()[:1200])
    app.get_by_role("heading", name="取景台").wait_for()
    assert app.locator("html").get_attribute("lang") == "zh-CN"
    app.locator(".dock-action-button").nth(1).click()
    app.locator(".app-shell.immersive-mode").wait_for()
    assert app.locator(".control-panel.action-panel").evaluate("element => getComputedStyle(element).display") == "none"
    app.keyboard.press("Escape")
    app.locator(".app-shell:not(.immersive-mode)").wait_for()
    assert app.locator(".control-panel.action-panel").is_visible()
    app.locator(".settings-trigger").click()
    dialog = app.get_by_role("dialog")
    directory_path = app.get_by_test_id("snapshot-directory-path")
    app.wait_for_function("() => document.querySelector('[data-testid=\"snapshot-directory-path\"]')?.textContent?.trim() === 'C:/Users/Playwright/Pictures/Default'")
    dialog.get_by_role("button", name="选择文件夹").click()
    app.wait_for_function("() => document.querySelector('[data-testid=\"snapshot-directory-path\"]')?.textContent?.trim() === 'C:/Users/Playwright/Pictures/Chosen'")
    assert directory_path.inner_text() == "C:/Users/Playwright/Pictures/Chosen"
    dialog.get_by_label("界面语言").select_option("en-US")
    app.get_by_role("heading", name="Device and preview settings").wait_for()
    assert app.locator("html").get_attribute("lang") == "en"
    assert app.title() == "Live View Studio — Webcam Viewer for Windows"
    assert_no_cjk(app.locator("body").inner_text(), allowed=("简体中文",))
    aria_text = app.locator("button,[aria-label],[title],video").evaluate_all(
        "nodes => nodes.filter(node => node.getClientRects().length).map(node => "
        "[node.innerText, node.getAttribute('aria-label'), node.getAttribute('title')].join(' ')).join(' ')"
    )
    assert_no_cjk(aria_text, allowed=("简体中文",))
    dialog.get_by_role("button", name="Done").click()
    app.get_by_role("button", name="Photo receiver").click()
    app.get_by_role("heading", name="Photo receiver").wait_for()
    assert_no_cjk(app.locator("body").inner_text())
    app.get_by_role("button", name="Done").click()
    app.reload(wait_until="networkidle")
    app.get_by_role("heading", name="Live View Studio").wait_for()
    assert app.title() == "Live View Studio — Webcam Viewer for Windows"
    app.locator(".settings-trigger").click()
    dialog = app.get_by_role("dialog")
    app.wait_for_function("() => document.querySelector('[data-testid=\"snapshot-directory-path\"]')?.textContent?.trim() === 'C:/Users/Playwright/Pictures/Chosen'")
    dialog.get_by_role("button", name="Reset to default").click()
    app.wait_for_function("() => document.querySelector('[data-testid=\"snapshot-directory-path\"]')?.textContent?.trim() === 'C:/Users/Playwright/Pictures/Default'")
    dialog.get_by_label("Interface language").select_option("zh-CN")
    app.get_by_role("heading", name="设备与取景设置").wait_for()
    assert app.locator("html").get_attribute("lang") == "zh-CN"
    app.get_by_role("button", name="完成").click()
    app.reload(wait_until="networkidle")
    app.get_by_role("heading", name="取景台").wait_for()
    app.locator(".settings-trigger").click()
    app.wait_for_function("() => document.querySelector('[data-testid=\"snapshot-directory-path\"]')?.textContent?.trim() === 'C:/Users/Playwright/Pictures/Default'")
    app.get_by_role("button", name="完成").click()
    assert not app_errors, f"App browser errors: {app_errors}"

    site = context.new_page()
    site.set_viewport_size({"width": 1200, "height": 630})
    site_errors: list[str] = []
    site.on("pageerror", lambda error: site_errors.append(str(error)))
    site.goto(SITE_URL, wait_until="networkidle")
    assert site.locator("html").get_attribute("lang") == "zh-CN"
    assert site.locator("h1").count() == 1
    assert site.locator('link[rel="canonical"]').get_attribute("href") == "https://xnnb04664-afk.github.io/live-view-studio/"
    assert site.locator('meta[name="description"]').get_attribute("content")
    assert site.locator('meta[property="og:image"]').get_attribute("content").endswith("/og-image.png")
    assert site.locator('meta[name="twitter:card"]').get_attribute("content") == "summary_large_image"
    assert site.locator('link[hreflang="en"]').get_attribute("href").endswith("/en/")
    site.screenshot(path=str(ROOT / "docs" / "og-image.png"))
    site.get_by_role("link", name="English").click()
    assert site.locator("html").get_attribute("lang") == "en"
    assert site.locator("h1").inner_text() == "Your camera,\nnow a viewfinder."
    assert site.locator('link[rel="canonical"]').get_attribute("href").endswith("/en/")
    assert site.locator('meta[property="og:image:alt"]').get_attribute("content")
    assert site.locator('link[hreflang="zh-CN"]').get_attribute("href").endswith("/")
    assert not site_errors, f"Website browser errors: {site_errors}"

    sitemap = ET.parse(ROOT / "docs" / "sitemap.xml")
    ns = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9", "xhtml": "http://www.w3.org/1999/xhtml"}
    entries = sitemap.findall("sm:url", ns)
    assert len(entries) == 2
    for entry in entries:
        alternates = {node.attrib["hreflang"] for node in entry.findall("xhtml:link", ns)}
        assert alternates == {"zh-CN", "en", "x-default"}

    browser.close()

print("PASS: Chinese/English app switch, photo-folder selection/reset persistence, transfer/settings text, localized metadata, reciprocal language links, sitemap, and static pages.")
