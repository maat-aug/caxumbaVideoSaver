<div align="center">

# 🎬 CaxumbaVideoSaver

<img src="img/caxumba.png" alt="Caxumba Video Saver" width="180" />

**Detecte e baixe vídeos MP4, HLS e DASH direto do navegador — sem servidores externos.**

![Manifest V3](https://img.shields.io/badge/Manifest-V3-4285F4?logo=googlechrome&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178C6?logo=typescript&logoColor=white)
![ffmpeg.wasm](https://img.shields.io/badge/ffmpeg.wasm-0.12-007808?logo=ffmpeg&logoColor=white)
![License](https://img.shields.io/badge/licença-privado-lightgrey)

</div>

---

CaxumbaVideoSaver é uma extensão de navegador (**Manifest V3**) que fareja vídeos **MP4**, **HLS** (`.m3u8`) e **DASH** servidos diretamente por uma página e permite baixá-los com poucos cliques. Tudo acontece localmente no seu navegador

## ✨ Funcionalidades

- **Detecção automática** de vídeos MP4, HLS e DASH carregados pela aba atual
- **Popup intuitiva** com a lista de vídeos encontrados, badges por tipo (`MP4` / `HLS` / `DASH`) e seleção de qualidade
- **Remuxagem no navegador** (via `ffmpeg.wasm`) para transformar streams HLS/DASH em um arquivo final pronto para baixar
- **Download 100% local**, usando a API `downloads` do Chrome

## 🚀 Instalação e build

```bash
npm install
npm run build
```

Depois:

1. Abra `chrome://extensions`
2. Ative o **Modo do desenvolvedor**
3. Clique em **Carregar sem compactação** e selecione a pasta `dist/`

> 💡 Prefere não compilar? Baixe o pacote pronto direto nas [releases do GitHub](../../releases).

## 📜 Scripts disponíveis

| Script | Descrição |
| --- | --- |
| `npm run build` | 📦 Gera a build de produção em `dist/` |
| `npm run watch` | 👀 Build em modo watch (desenvolvimento) |
| `npm run typecheck` | ✅ Checagem de tipos com `tsc --noEmit` |
| `npm run clean` | 🧹 Limpa os artefatos de build |

## 🗂️ Estrutura do projeto

```
src/
├── background.ts        # 🛰️  service worker: detecção de requisições de vídeo
├── content/content.ts   # 💉 content script injetado nas páginas
├── popup/                # 🖼️  UI da popup da extensão
├── hls/                  # 📡 parsing e remux de playlists HLS
├── dash/                 # 🎞️  parsing e remux de manifests DASH
└── media/ffmpeg.ts       # 🔧 integração com ffmpeg.wasm
```
