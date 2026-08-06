# Forge ChatGPT Browser Engine

Forge exposes browser automation through the bundled `browser` capability, the stable plugin action surface, and bounded Process Runtime execution. Browser actions remain policy-scoped, domain-allowlisted, timeout-bounded, and evidence-producing. Human login, MFA, CAPTCHA, consent, or device approval uses the Human Interaction Plane rather than hidden automation.

Authoritative references:

- [Browser plugin operations](operations/controller-browser-plugin.md)
- [Human Interaction Plane](architecture/current/human-interaction-plane.md)
- [Plugin baseline](architecture/current/personal-assistant-plugin-baseline.md)

The browser engine is not a second controller, Runtime, plugin marketplace, or lifecycle owner.
