<div align="center">

<img src="./apps/web/public/icons/app-icon-192.png" alt="Imagine Media Studio" width="80" />

# Imagine Media Studio

**軽量なセルフホスト型の画像・動画制作ワークスペース**

お使いの AI API を接続して、生成・編集・作品管理をひとつのワークスペースで。

コンテナひとつ · GPU 不要 · PC・スマートフォン対応 · 日本語 / English / 中文

[![Release](https://img.shields.io/github/v/release/YuSaZh/imagine-media-studio?style=flat-square)](https://github.com/YuSaZh/imagine-media-studio/releases/latest) [![Docker](https://img.shields.io/badge/Docker-amd64%20%7C%20arm64-2496ed?style=flat-square&logo=docker&logoColor=white)](https://github.com/YuSaZh/imagine-media-studio/pkgs/container/imagine-media-studio) [![CI](https://github.com/YuSaZh/imagine-media-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/YuSaZh/imagine-media-studio/actions/workflows/ci.yml) [![License](https://img.shields.io/badge/License-MIT-22a06b?style=flat-square)](./LICENSE)

[简体中文](./README.md) · [English](./README_EN.md) · **日本語**

[主な機能](#features) · [画面プレビュー](#screenshots) · [クイックスタート](#quick-start) · [ドキュメント](#documentation)

</div>

<a id="features"></a>
## 制作に必要な機能を、ひとつに

| 特徴 | できること |
| --- | --- |
| **🎨 画像制作** | テキストからの画像生成、参照画像を使った編集、マスクによる部分編集。生成結果からそのまま次の制作へ進めます。 |
| **🎬 動画制作** | テキスト・開始フレーム・複数の参照画像から動画を生成。対応モデルでは動画編集、延長、開始・終了フレームの指定も可能です。 |
| **🗂️ 作品管理** | 画像と動画をまとめて管理。プロジェクト、検索、お気に入り、一括操作に対応し、元画像と派生作品をシリーズで閲覧できます。 |
| **🔌 モデルを選べる** | OpenAI 互換 API、Google Gemini、xAI、カスタムアダプターに対応。生成設定をプロジェクト・モデルごとに保存します。 |
| **🌗 好みの使い心地** | ライト・ダーク・システム連動のテーマと、日本語・英語・中国語の UI。PC とスマートフォン専用のレイアウト、滑らかな画面遷移、タッチ操作を備えています。 |
| **🏠 自分のサーバーで** | コンテナひとつと SQLite で動作。作品は自分のサーバーに保存し、アカウントごとにデータを分離。API キーはサーバー側で暗号化します。 |

利用できる生成機能はモデルと API 提供元によって異なります。モデルや API 利用枠は含まれず、プロンプトと参照素材は選択した提供元に送信されます。詳細は[モデルの対応機能](./docs/model-capabilities.md)をご覧ください。

<a id="screenshots"></a>
## 画面プレビュー

<table>
  <tr><th>PC のワークスペース</th><th>スマートフォンのワークスペース</th></tr>
  <tr>
    <td width="76%"><img src="./e2e/visual-baselines/workspace/workspace-1440x900/workspace.png" alt="PC のワークスペース" width="100%" /></td>
    <td width="24%"><img src="./e2e/visual-baselines/workspace/workspace-390x844/workspace.png" alt="スマートフォンのワークスペース" width="100%" /></td>
  </tr>
</table>

テスト素材を使用したライトテーマの表示例です。ダークテーマにも対応しています。

<a id="quick-start"></a>
## クイックスタート

**Docker Compose v2** があれば導入できます。**AMD64 / ARM64** に対応。以下の初回セットアップには Bash と `openssl` を使用します。

### 1 · ディレクトリと初期設定を作成

```bash
mkdir imagine-media-studio && cd imagine-media-studio
umask 077
mkdir -m 700 data
(
  set -o noclobber
  printf 'APP_SECRET=%s\nADMIN_USERNAME=admin\nADMIN_PASSWORD=%s\nPUID=%s\nPGID=%s\n' \
    "$(openssl rand -hex 32)" "$(openssl rand -hex 16)" "$(id -u)" "$(id -g)" > .env
)
```

初期ユーザー名は `admin`、ランダム生成されたパスワードは `.env` の `ADMIN_PASSWORD` で確認できます。**更新時も `.env` と元の `APP_SECRET` を保持してください。** 保存済み API キーの復号に必要です。

### 2 · `compose.yaml` として保存

```yaml
services:
  imagine-media:
    image: ghcr.io/yusazh/imagine-media-studio:latest
    restart: unless-stopped
    user: "${PUID:-1000}:${PGID:-1000}"
    ports:
      - "${IMAGINE_MEDIA_HOST_PORT:-3030}:3030"
    env_file: .env
    environment:
      APP_PORT: "3030"
      DATA_DIR: /data
      MOCK_PROVIDER_ENABLED: "false"
    volumes:
      - ./data:/data
```

### 3 · 起動

```bash
docker compose up -d
```

**http://localhost:3030** を開いてログインします。別のサーバーに配置した場合は、そのアドレスに置き換えてください。ポートを変更するには `.env` に `IMAGINE_MEDIA_HOST_PORT=使用するポート番号` を追加します。

<a id="providers"></a>
### API を接続して、制作を始める

1. **設定 → 接続**で、提供元の種類、Base URL、API キーを入力します。
2. カタログからモデルを追加するかモデル ID を入力し、プロトコルと対応する操作を確認します。
3. 制作画面に戻り、画像または動画を選び、プロンプトを入力して生成します。

初期表示は簡体字中国語・ライトテーマです。**设置 → 偏好**（設定 → 環境設定）でテーマを変更でき、**界面语言**から日本語を選べます。

OpenAI 互換 API の Base URL は通常 `https://api.example.com/v1` のような形式です。`/chat/completions` まで含む URL は指定しません。その他の接続方法は[カスタムアダプターの例](./examples/custom-providers/README.md)をご覧ください。

<a id="configuration"></a>
<a id="faq"></a>
<details>
<summary>追加設定と PWA</summary>

`PUBLIC_BASE_URL` や、プライベートネットワーク内の API に接続するための `ALLOW_PRIVATE_NETWORK_ACCESS=true` などを `.env` に追加し、コンテナを再作成します。設定一覧は [.env.example](./.env.example) を参照してください。外部公開には HTTPS を使用してください。PWA のインストールも原則 HTTPS が必要です（ローカルの `localhost` は例外）。オフラインではキャッシュ済みのプレビューと下書きを利用できます。

</details>

## 更新もシンプルに

データをバックアップし、既存の `.env` と `data/` を保持したまま、配置先ディレクトリで実行します。

```bash
docker compose pull
docker compose up -d
```

`latest` は最新の安定版を指します。バージョンを固定する場合は `:0.2.1` またはリリースページのイメージ digest を使用してください。バックアップ・移行・ロールバックは[デプロイガイド](./RELEASE.md)を参照してください。UI のデータベースバックアップには画像や動画は含まれません。

<a id="development"></a>
<a id="documentation"></a>
## 詳しく知る

- [変更履歴](./CHANGELOG.md) · [リリース](https://github.com/YuSaZh/imagine-media-studio/releases) · [既知の制限](./Hold.md)
- [モデルの対応機能](./docs/model-capabilities.md) · [デプロイとデータ管理](./RELEASE.md) · [ドキュメント一覧](./docs/README.md)
- [開発・コントリビュート](./CONTRIBUTING.md) · [不具合の報告](https://github.com/YuSaZh/imagine-media-studio/issues)

---

[MIT License](./LICENSE) · UI と操作は Grok Imagine を参考にしています。利用範囲は[第三者ライセンス表記](./THIRD_PARTY_NOTICES.md)と[再利用の監査記録](./docs/third-party/reuse-audit.md)をご覧ください。
