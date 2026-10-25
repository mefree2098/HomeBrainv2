# HomeBrain Alexa Session Helper

This helper lets HomeBrain capture a fresh Alexa web session after you explicitly sign in to Amazon.

Install once in Chrome or Edge:

1. Download and unzip `homebrain-alexa-session-helper.zip`.
2. Open `chrome://extensions` or `edge://extensions`.
3. Enable Developer mode.
4. Choose Load unpacked.
5. Select the unzipped `homebrain-alexa-session-helper` folder.

After that, use HomeBrain's Alexa Broker page and click Capture Alexa Session.

Download the helper from the HomeBrain site that will receive the session. Each downloaded helper is bound to that site's HTTPS host (or the actual loopback host for local development). It returns the session through that capture page, retaining HomeBrain's normal CORS policy and one-time capture-token checks. Cookie values stay in extension messages and the request to HomeBrain; page progress contains cookie names only.

Version 1.0.2 requests Alexa's read-only session bootstrap when Amazon has not issued the CSRF cookie, and checks Amazon's first-party cookie partition as well as ordinary cookies. Each unchanged session gets one bounded bootstrap pass; requests never follow redirects or submit device commands. The helper still requires Amazon's actual session and CSRF cookies before returning anything to HomeBrain. It reports missing session pieces and return errors on the capture page. Collection stops when that page closes or after ten minutes. After updating an unpacked helper, reload it in the browser's extensions page before starting a new capture.
