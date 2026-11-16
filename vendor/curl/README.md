# curl

Windows 上沙箱里的命令用这个 curl：Git Bash 自带的 curl 只用 Schannel，在沙箱账户里访问不了 HTTPS。见设计文档「沙箱」。

- 来源：curl 官网的 Windows 版 <https://curl.se/windows/>，8.23.0_8，x64，LibreSSL，读 Windows 的系统证书库。
- 下载的 `curl-8.23.0_8-win64-mingw.zip`，SHA-256 `ca5b0fd6e7a6dbde210281f545c73a89784f2e88104a2cdfe0b73ea3dfed5b3a`，和官网的 `hashes.txt` 一致。
- 只取了 `bin/curl.exe`（SHA-256 `35121e9cb7c2ae16187f8c5311a840ce4191d6753525138f7fbfbe46511bc271`，和压缩包里的 `BUILD-HASHES.txt` 一致）、curl 的 `COPYING.txt`，和 `dep` 下编进 `curl.exe` 的库的许可证。
- 升级：从官网下新版，核对 SHA-256，换掉这些文件。
