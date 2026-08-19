# RHWP editor temporary vendoring

`rhwp-editor-0.8.5.tgz`는 upstream package 게시 전 production 배포를 막지 않기 위한 임시 exact
dependency다.

- package: `@rhwp/editor@0.8.5`
- source repository: `https://github.com/edwardkim/rhwp`
- source PR: `https://github.com/edwardkim/rhwp/pull/5569`
- exact source commit: `c02f422c46e258b43a91a45f187d1513b445923e`
- SHA-256: `1c83c0fd0d6924b09c11f3fcdb184882aad563b5e3556674686ae4e22f366b12`
- npm pack SHA-1: `4aaa287582f6967afb27acf1716adf67744d3548`

upstream이 `@rhwp/editor@0.8.5`를 npm에 게시하면 `apps/web/package.json`을 exact registry version
`0.8.5`로 바꾸고 이 디렉터리를 제거한다. 교체 전에는 registry tarball의 공개 API와 현재 artifact
내용이 같은지 확인한다.
