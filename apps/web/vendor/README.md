# RHWP editor temporary vendoring

`rhwp-editor-0.8.5.tgz`는 upstream package 게시 전 production 배포를 막지 않기 위한 임시 exact
dependency다.

- package: `@rhwp/editor@0.8.5`
- source repository: `https://github.com/edwardkim/rhwp`
- source PR: `https://github.com/edwardkim/rhwp/pull/5569`
- exact source commit: `104ed4dad71dccd3cf1c97963200d483299f2640`
- upstream merge commit: `b0c0a08394f9318f23d562192458c688b136cd06`
- editor package tree: `f2fe7325d55b3c9a63bd2908cab1df5f0f3d642e` (exact source와 merge된 PR head 동일)
- SHA-256: `d76db865d87e2a688c1409bb960b6b873f97aff28f7a37a0effe1009572aef4a`
- npm pack SHA-1: `536871833cfd13eeefcb100e1aa3a745715f3799`

upstream이 `@rhwp/editor@0.8.5`를 npm에 게시하면 `apps/web/package.json`을 exact registry version
`0.8.5`로 바꾸고 이 디렉터리를 제거한다. 교체 전에는 registry tarball의 공개 API와 현재 artifact
내용이 같은지 확인한다.

현재 의존성은 `pnpm verify:rhwp-editor-dependency`로 package name/version, tarball SHA-256,
`pnpm-lock.yaml`의 SHA-512 integrity를 검증한다. registry 전환 뒤에도 같은 명령을 실행해 exact
`0.8.5` lock과 vendor 참조 제거를 확인한다.
