# App Etiquetas

Escolha as etiquetas, diga quantas folhas e imprima direto pelo cabo USB (OTG) numa Epson, sem outro app no meio.

- **Abrir:** https://richard54733.github.io/App-Etiquetas/ (Chrome no Android → "Adicionar à tela inicial")
- Funciona offline (PWA), junta os PDFs num arquivo único, envia no WhatsApp, guarda histórico.
- Impressão direta via WebUSB com dois motores em JavaScript:
  - `js/escpr.js` — ESC/P-R, portado do driver oficial `epson-inkjet-printer-escpr` (GPL-2.0+); saída idêntica byte a byte.
  - `js/escp2.js` — ESC/P2 raster para Epson L210/L110/L355, com parâmetros do Gutenprint `escp2-l210` (GPL-2.0+).
- Catálogo em `catalog/` (gerado por `tools-gerar-catalogo.py`).

Manual completo: veja "Manual App Etiquetas.pdf" na pasta do projeto no computador.

Licença: GPL-2.0-or-later (por derivar do escpr e do Gutenprint). pdf.js (Apache-2.0), pdf-lib (MIT), Atkinson Hyperlegible (OFL).
