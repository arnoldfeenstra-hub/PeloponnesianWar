// quick screenshots: node qa/shot.mjs '#timeline/alcibiades' name [dark] [w] [h]
import { chromium } from "playwright";
const [hash, name, theme, w = 1440, h = 900] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const p = await b.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 2, ignoreHTTPSErrors: true, colorScheme: theme === "dark" ? "dark" : "light" });
p.on("pageerror", (e) => console.log("pageerror", e.message));
await p.addInitScript(() => { try { localStorage.setItem("intro", "1"); } catch {} });
await p.goto((process.env.BASE_URL || "http://localhost:4173") + "/" + hash);
await p.waitForFunction(() => window.__app?.model?.nodes?.length > 0);
await p.waitForTimeout(+(process.env.WAIT || 5000));
await p.screenshot({ path: `qa/screenshots/${name}.png` });
await b.close();
