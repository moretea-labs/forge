const PRODUCT_BINDING_PATTERNS = [
  { label: "macOS personal absolute path", pattern: /\/Users\/[A-Za-z0-9._-]+\// },
  { label: "Linux personal absolute path", pattern: /\/home\/[A-Za-z0-9._-]+\// },
  { label: "Windows personal absolute path", pattern: /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\/ },
  { label: "WSL personal Windows path", pattern: /\/mnt\/[a-z]\/Users\/[A-Za-z0-9._-]+\//i },
  {
    label: "fixed macOS browser executable path",
    pattern: /\/Applications\/(?:Google Chrome|Google Chrome Canary|Chromium|Microsoft Edge|Brave Browser)\.app\/Contents\/MacOS\//,
  },
  {
    label: "fixed Linux browser executable path",
    pattern: /\/usr\/(?:local\/)?bin\/(?:google-chrome(?:-stable)?|chromium(?:-browser)?|microsoft-edge(?:-stable)?|brave-browser)\b/,
  },
  {
    label: "fixed Windows browser executable path",
    pattern: /[A-Za-z]:\\(?:Program Files(?: \(x86\))?\\)?(?:Google\\Chrome|Microsoft\\Edge|BraveSoftware\\Brave-Browser)\\Application\\[^\s"']*\.exe/i,
  },
  {
    label: "fixed macOS browser profile path",
    pattern: /Library\/Application Support\/(?:Google\/Chrome|Chromium|Microsoft Edge|BraveSoftware\/Brave-Browser)\/(?:Default|Profile [0-9]+)/,
  },
  {
    label: "fixed Linux browser profile path",
    pattern: /\.config\/(?:google-chrome|chromium|microsoft-edge|BraveSoftware\/Brave-Browser)\/(?:Default|Profile [0-9]+)/i,
  },
  {
    label: "fixed Windows browser profile path",
    pattern: /(?:AppData\\Local|%LOCALAPPDATA%)\\(?:Google\\Chrome|Microsoft\\Edge|BraveSoftware\\Brave-Browser)\\User Data\\(?:Default|Profile [0-9]+)/i,
  },
];

export function findPortabilityBindings(path, content) {
  const findings = [];
  for (const { label, pattern } of PRODUCT_BINDING_PATTERNS) {
    if (pattern.test(content)) findings.push({ path, label });
  }
  return findings;
}

export function portabilityBindingDetectorSelfCheck() {
  const bad = [
    ["/Users/alice/DevProjects/forge", "macOS personal absolute path"],
    ["/home/alice/forge", "Linux personal absolute path"],
    ["C:\\Users\\alice\\forge", "Windows personal absolute path"],
    ["/mnt/c/Users/alice/forge", "WSL personal Windows path"],
    ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "fixed macOS browser executable path"],
    ["/usr/bin/google-chrome-stable", "fixed Linux browser executable path"],
    ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "fixed Windows browser executable path"],
    ["~/Library/Application Support/Google/Chrome/Default", "fixed macOS browser profile path"],
    ["~/.config/google-chrome/Profile 2", "fixed Linux browser profile path"],
    ["%LOCALAPPDATA%\\Google\\Chrome\\User Data\\Default", "fixed Windows browser profile path"],
  ];
  const failures = [];
  for (const [content, expectedLabel] of bad) {
    const labels = findPortabilityBindings("fixture", content).map((finding) => finding.label);
    if (!labels.includes(expectedLabel)) failures.push(`missed ${expectedLabel}`);
  }
  for (const safe of [
    "discoverPreferredNativeBrowserProduct()",
    "resolveBrowserProfileFromProvider(provider)",
    "join(homedir(), configuredProfileRoot)",
  ]) {
    const findings = findPortabilityBindings("fixture", safe);
    if (findings.length > 0) failures.push(`false positive for ${JSON.stringify(safe)}: ${findings.map((finding) => finding.label).join(", ")}`);
  }
  return failures;
}
