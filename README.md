# Caxumba Video Saver

![alt text](img/caxumba.png)

Extensão de navegador (Manifest V3) que detecta vídeos **MP4**, **HLS** (`.m3u8`) e **DASH** servidos diretamente por uma página e permite baixá-los, sem depender de nenhum servidor externo.

## Funcionalidades

- Detecta automaticamente vídeos MP4, HLS e DASH carregados pela aba atual.
- Popup com a lista de vídeos encontrados, badges por tipo (MP4/HLS/DASH) e seleção de qualidade.
- Remuxagem no navegador (via `ffmpeg.wasm`) para gerar um arquivo final baixável a partir de streams HLS/DASH.
- Download feito localmente pela API de `downloads` do Chrome — nada passa por um servidor de terceiros.

## Instalação e build

```bash
npm install
npm run build
```

Depois, carregue a pasta `dist/` como extensão não empacotada em `chrome://extensions` (com o "Modo do desenvolvedor" ativado).

Para gerar uma build de produção:

```bash
npm run build:release
```

## Scripts disponíveis

| Script | Descrição |
| --- | --- |
| `npm run build` | Build de desenvolvimento |
| `npm run watch` | Build de desenvolvimento em modo watch |
| `npm run build:release` | Build de produção |
| `npm run typecheck` | Checagem de tipos com `tsc --noEmit` |
| `npm run clean` | Limpa os artefatos de build |

## Estrutura do projeto

```
src/
├── background.ts        # service worker: detecção de requisições de vídeo
├── content/content.ts   # content script injetado nas páginas
├── popup/                # UI da popup da extensão
├── hls/                  # parsing e remux de playlists HLS
├── dash/                 # parsing e remux de manifests DASH
└── media/ffmpeg.ts       # integração com ffmpeg.wasm
```
