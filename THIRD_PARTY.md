# 第三方组件

项目本身用 MIT 许可（见 [LICENSE](LICENSE)）。仓库里随代码一起分发的第三方内容列在这里。

| 组件 | 版本 | 在哪 | 许可 |
|---|---|---|---|
| curl | 8.23.0（8.23.0_8，win64 mingw，x64） | `vendor/curl/curl.exe` | curl 的许可，见 `vendor/curl/COPYING.txt` |
| curl 编进去的库 | brotli、libpsl、LibreSSL、libssh2、nghttp2、ngtcp2、nghttp3、zlib、zstd | `vendor/curl/dep/` | 各自目录里的许可文件 |

curl 的来源地址、压缩包和 `curl.exe` 的 SHA-256、升级步骤，写在 [vendor/curl/README.md](vendor/curl/README.md)。

npm 依赖不随仓库分发，装依赖时由各包自己带来，许可在各自的 `node_modules` 里。
