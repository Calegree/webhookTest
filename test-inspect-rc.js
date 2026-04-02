const { chromium } = require("playwright");

async function main() {
  const browser = await chromium.launch({ headless: false }); // visible para debug
  const page = await browser.newPage();

  await page.goto(
    "https://www.registrocivil.cl/OficinaInternet/verificacion/verificacioncertificado.srcei",
    { waitUntil: "networkidle", timeout: 30000 }
  );

  // Inspeccionar todos los inputs
  const inputs = await page.locator("input").all();
  console.log(`\n📝 Inputs encontrados: ${inputs.length}\n`);
  for (let i = 0; i < inputs.length; i++) {
    const name = await inputs[i].getAttribute("name");
    const id = await inputs[i].getAttribute("id");
    const type = await inputs[i].getAttribute("type");
    const placeholder = await inputs[i].getAttribute("placeholder");
    console.log(`  [${i}] name="${name}" id="${id}" type="${type}" placeholder="${placeholder}"`);
  }

  // Inspeccionar botones
  const buttons = await page.locator("button, input[type=submit]").all();
  console.log(`\n🔘 Botones encontrados: ${buttons.length}\n`);
  for (let i = 0; i < buttons.length; i++) {
    const text = await buttons[i].textContent();
    const id = await buttons[i].getAttribute("id");
    const type = await buttons[i].getAttribute("type");
    console.log(`  [${i}] text="${text.trim()}" id="${id}" type="${type}"`);
  }

  // Capturar el HTML del formulario
  const formHtml = await page.locator("form, .container, #content, body > div").first().innerHTML();
  console.log("\n📄 HTML del formulario (primeros 2000 chars):");
  console.log(formHtml.substring(0, 2000));

  await browser.close();
}

main().catch(console.error);
