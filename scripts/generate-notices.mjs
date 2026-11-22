#!/usr/bin/env node
/**
 * Offline, dependency-free notice collection. This script executes only Cargo
 * metadata (never a build, dependency install, package code, or lifecycle hook).
 * Run: node scripts/generate-notices.mjs [--check] [--target <Windows MSVC triple>]
 * Exit 0 means collection/check succeeded, NOT that redistribution is cleared.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';

// Official text snapshots, independently fetched/verified during development.
// Deflate+base64 is an exact-byte transport, not generated license language.
// Runtime collection stays offline; URLs, source revisions and SHA-256 values
// remain in every package notice. Never apply these to an unmatched version.
const VERIFIED_UPSTREAM_TEXT = {
  dropbox: {
    sourceURL: 'https://raw.githubusercontent.com/dropbox/rust-alloc-no-stdlib/0a81fd6928ea3b33c8cd484aa4575d50ffb98012/LICENSE',
    sha256: 'c0c56f26d9c051cac4d200c34c84e7ae9aaa853e01a982a1df08b09931e518ae',
    deflateBase64: 'rZLNjts2FIX3foqDrDKA4CYp0EWzoiXaIiCTKkmN46VGomMClmiQ9Ezn7QvSHozTFOgmK12I9+ec797SnV+9/X6M+Dg84Munz3+g8u785P4uwOZhuSCnE3JCgDfB+GczLhcLaUYbordPl2jdjH4ecQkGdkZwFz+Y/OfJzr1/xcH5KRR4sfEI5/PXXSImN9qDHfrUoEDvDc7GTzZGM+Ls3bMdzYh47CPi0eDgTif3YufvGNw82lQUctFk4p+LxeclfpQU4A5vWgY3GkyXEOFN7O2cG/ZP7jk9vdmfXbSDKRCPNuBkQ0wN7mfN47+EjDYMp95Oxi8Xiy8/C7DzPYE3AWfvxstgfrkG3HyNbrhMZo7922J+cx4uHo3H1EfjbX8K73zzUnLZnfTlYvH7EtzYXJVe534ySUuK3+Ue3Wk0HrN7T8rYbQxJ9bWf8wFT/4onky5kRHQw8+h8MOkYzt5NLhpcqcSA0Xj7bEYcvJuuHII7xJe06bfDCWczpMvB2dt0Tz7dzHy9nhCu+nXNFJRY6x2RFEyhleKRVbTCag9dU5Si3Uu2qTVq0VRUKhBeoRRcS7bqtJAKH4gCUx/yA+F70G+tpEpBSLBt2zBaYUekJFwzqgowXjZdxfimwKrT4EKjYVumaQUtijz05zKINbZUljXhmqxYw/Q+z1szzdOstZAgaInUrOwaItF2shWKItmqmCobwra0WoJxcAH6SLmGqknT/KfLpP0HjyuKhpFVQ6+T+B4Vk7TUyc57VLKKck2aAqqlJUsB/Ua3bUPkvrj1VPSvjnLNSIOKbMmGKnz8HyStFGUn6TZpFmuobqU0052m2AhRZdCKykdWUvUVjVCZVqdogYpokge3UqyZVl9TvOoUy9AY11TKrtVM8AfUYkcfqURJOkWrTFfwbFXXVMh9apoYZPgFdjXVNZUJaCZFEgKlJSv1fZqQ0ELqO4/gdNOwDeUlTa8iddkxRR9AJFMpgV3H7sgeosuW0446Ra/h3cUWeZNga5DqkSXZt+RWKMVud5KRlfUN93LxDw==',
  },
  clipboard: {
    sourceURL: 'https://raw.githubusercontent.com/DoumanAsh/clipboard-win/ed27008ae5d1f10cfbb266de039f0fb35fd05a56/LICENSE',
    sha256: 'c9bff75738922193e67fa726fa225535870d2aa1059f91452c411736284ad566',
    deflateBase64: 'dZLBbus2EEX3/IpBVn2AHOS9Lgp0J1u0TVQmDYqOmyVNjSW2MimQVFL36wvKTpqg6I4S5965czhL72OCxp/Tmw4ItTXoIsICnjFE6x18f3yCBZRTN8UE339JfQE/np5+JmSP4WLjXGMj9BjwdIUuaJewLeAcEMGfwfQ6dFhA8qDdFUYM0TvwAXzotLN/62S9I/6UtHXWdaDB+PGalalHiO+5tGtBG+Mvo3bXXNd6M13QpVkPxr9iwBZOV5J6G2G4j/FTNnl4n+7hW44xRSwg4Bh8OxksoLVxHPR1PqRgT1PCguBfaPJhbpyCdvFi0xzp3ex+5WEMOOaILQb7qpN9RXjz4c94n4H8V5DBZTMb2sWoQ7IY8/+33l++tMhcz1NwNvaYlaT1EH0BehggTqc/0KSsy5KzHwb/Zl33KyGqxxlisF2fwPlkDUaw7qv3HCazQpdsQIhJJ8xEC7DODFNrXUeyQp/8K34QnR+4uCkDZmBmfoGb3acgGacZtL1gKMglL88J787Y5jR5CuPHPPz9tf8lZV2mMWBeFOsgQ5rxkSz6H9Cf5JMbMEaIk+k/WoRPOnLTZQzRDzhc3+mcfbhku4s2vXW4uK2BPuUkN97GtwgdOgw63RZOQ/RTMAiDdt2kO4QxeIMx+vBIiNpSaMRaHUtJgTWwl+KZVbSCh7IB1jwUcGRqKw4KjqWUJVcvINZQ8hf4jfGqAPr7XtKmASEJ2+1rRqsCGF/Vh4rxDSwPCrhQULMdU7QCJSA3vFsx2mSzHZWrbclVuWQ1Uy8FWTPFs+daSChhX0rFVoe6lLA/yL1oaAGKqZpCySvggi8YX0vGN3RHuXoExoELoM+UK9Jsy7qeW67E/kWyzVbBVtQVlTlxHkNwChVrlGTLg8qRvwBZUqhZuawpWd/KoSp35YbOaqG2VM73t9xw3NL5F+OwElzJcqUKUEKqj+oja2hBSsma3Gotxa6AzFasc8lNx+lKMcFn7l/TCDl/Hxr6YUgqWtaMb5os/lz8SP4B',
  },
  webviewRust: {
    sourceURL: 'https://raw.githubusercontent.com/wravery/webview2-rs/edc2caf886175ccaebe86078c9cfe1ae2a187328/LICENSE',
    sha256: '0dcf41516e608bbcb6cdc5229feb7b86fe4a643b85e7df251133c93408fdac73',
    deflateBase64: 'XVHLbtswELzzKwY5tYCQPo690RJtEZVJg6Lj+ihLdMRCFg2RTuC/L1Z20qYngrs7Mzuza2lR+daN0TGWh/N18s99wqf2M75//f4NCz8M4C9uujK2cdPJx+jDCB/Ru8kdrniemjG5LsNxcg7hiLZvpmeXIQU04xVnN8UwIhxS40c/PqNBG85XFo5IvY+I4Zhem8mhGTs0MYbWN8l16EJ7ObkxNYn0jn5wEZ9S7/BQ3xEPn2eRzjUD8yOo99bCq099uCRMLqbJt8SRwY/tcOloh7f24E/+rkDw2XtkKeASXTbvmeEUOn+k1822zpfD4GOfofNEfbgklyFScQ4xIx9fwoTohoG14exdxOz173bzDK1+pkDTPaJIldc+nD468ZEdL9PoY+9mTBcQw6z427WJKjR+DMMQXslaG8bOk6P4gzHbOzSH8OJmL7fTjiH59hb3fIDz36veW7FvhgEHdw/MdfAjmn/sTCQfUzMm3ww4h2nW+9/mI2O2FKj10u64EZA1NkY/yUIUeOA1ZP2QYSdtqbcWO24MV3YPvQRXe/yUqsggfm2MqGtow+R6U0lRZJAqr7aFVCssthZKW1RyLa0oYDVI8E4lRU1ka2HykivLF7KSdp+xpbSKOJfagGPDjZX5tuIGm63Z6FqAqwJKK6mWRqqVWAtlHyEVlIZ4EsqiLnlVkRTjW1tqQ/sh15u9kavSotRVIUyNhUAl+aISNym1R15xuc5Q8DVfiRmlbSkMo7HbdtiVgkqkxxV4bqVWZCPXyhqe2wxWG/sO3claZOBG1hTI0uh1xihOvaQRqQinxI2FosaHi2gz/7e1eCdEIXgl1aomMFl8G35kfwA=',
  },
  mpl: {
    sourceURL: 'https://www.mozilla.org/media/MPL/2.0/index.txt',
    sha256: '3f3d9e0024b1921b067d6f7f88deb4a60cbe7a78e76c64e3f1d7fc3b779b9d04',
    deflateBase64: 'zVxtj9w2kv7OX0EMcMjMQiN7Zuxk14v74E2cnAHbCNbJBfuRLZW6mWGTCklNu/fXH6qKpCh1j18W3rvzh409IxXJYr089VRp37p/amOU/HnaGN3JN7oDG0D+N/ignZW37VPxn5/8I8RNK3+AQVsdtbNBXC/+4K9vWnnxvbPR680Unb8QUkq5B2WDBNXtpLa9ftD9pIx0XhrYKiPBRh2PMu5UlJ0HFSE0sstCIMjoSEzcAf8ed+yGBiW4gw3ye/cAHnr53g3xoDy0uJPb5U7yUesdkUC332ibZdKPylt4RvyhizvwQV7qQSp7vJJTgJ7EbI5SyXoRZXs+x6h81N1klK9//01YCKd93tX7XG1wfTDcjHpENgl7RsKWL9UC37vJd3jCHuSPzu9ldPKw092ODk73qsziRDsVpIpRdbt0ZnzQuqg7fF6++rDTGx3ly4Z+8eoDdFNUG5PEu0GGqdvV65IQ/GVD2nrrej3oThVlr59Pz2rLBtSpwCK07czUa7uVo/P8Nl4TuIE08byVF69t5/ajihr385uOO/keOmd75Y/ZA0KlHUF/vVRXfIWfo5FaGz2EzutNUhNvsejnb6hpNq7l7fxVOp8W3lQLn9z8QQW5Vz1I9aC0IQ1PtgdPT0fwe1ReWfkh+fVNe4NeAsobDT4beDp7IzdTxN1LZYKbxRUpWaxUp4ojJX/byovVldfWpuxRDskMcN2D8/fsTHhQe3LLJPO7Vl68UX4LXv7m/P1CHkvgQEF+C2d85IAXzavsVQSvlUHzITlKBhiVVxHkoA2gbvC/oWGhOpA6zsaTP+O++OzLGKKD7F037cFGevAv5UFUSv3sTj2gvaIqvN7uItrE1isbm2wde/VB76e9hA8RbJSjCwGNtyEhhx3QqZKJRL2HrNlspyQNTxWmTYA/JrDRHBu6CGXZMJUx+S3aRMBQ+wBH6DGc0XHqK7552sqLhZOubzgJG5wx7qDt9sXsR2QAqGdtz4Qe1LiHMJkY5ODdXiorVd9TbpHRNcUOezBAP8SnKOzvqw3lDWDGABvJYNMNFgnnvQ23Z+HwiS2iXKXTYR8TzLrC7Pezoqv73ii9DxfsPVX4WClv5Kc7fPoyXDVVWEM7dlOURu91pJM2cg9x53rWzOhdByFwGFUjmfUUWFSggFktMBsk3jLGWJJRxzU67MFNppcbVMfgtd1Cz1FicBxpkoENJU7MseSYLPhe220jp0D/CWAM/cUNA6BAkhSUgSa5AytE9dBIvcdQThccvbJh4JAFmsxex7BOzfTDk4OkTM9XgjDgJHgtYIlOAQnkT+9+lT+BBa/MCig1NVJq8sOsAAgB/Ge8d1Peky9RGS6/Q2Iee+8O1yNkcZQGw1mO7YFvwaV0aFI+41MjqFhb8xr5nETm0cMAHgMf3hFf5MLTknAEGf9w04W8dJ7+5i+uFma9QnlqifPgA/hOo3nkAJQzjw61SbW46/pVjXGaV2YvAfahCj/S+wQdnUEfCPkfhsIbaVLnBTu33zubn+C88Q830brsYZMfXYCkaYzzBfs28iK9d5GOzbgB5OgO4BvZaw8d7wfXtPxvCvSdmgLQs/xDimGocKu2gGmkwCA+2TL6b468Y9VRoKdEd9BoMs5TVHMHCz7s9Ihi9s4DJVuSMeghHuUIvsNVLp8//Y+rbAFuiiEqS5En7JQHcq8NWBh0p5ORLkRXO2yFuG1LUfETxohAYel7Z/uztcLpHxRx06aXhXiFYG8Bu8DD5sgBKOA9MRww/fVBY/Dw7qhMPF4PHqAR1tlr+NCZKegHyM7xQgi8Jb59bSMYA11EKx29G8HHY7bIywqlpAjKQamHvfL3V5Wd1jF1GU8dFgqN9DB6108dNOhTFYDjeyUHO6LBhNGoY4PXMxDk7XVIJRDH+HLVEj6Mxul4Gv1Q000OaQ4zgJwsuzA6gAo6NGzoi5SOtsPgIFB1wVmrQmF/Jfgg0LxYe4ssV6xhdXw8bsNKwDyQkgBbYp0FYBX/l4ctqWDOA6eHTrngkTxwi9Xgq2FAZ3sA+YOKIMQvu2IYgc0KekIBySVv2xtWlYcwQkdojSHAvK7YQOf2IKHIHghu17og97bs7wg8FyUmAVAfopgvO6x0mY9whx6WoUBAkeQr8n3nxo8chwJXOZNUnnfgrCnWnp+mqxULCCjfuYLJlMkvYFzOSx20MQQY9qNBIyMkh+ignCjFN34D48sM0GbUPueAGX6+cxEvoMSl6mYIvm3cAzTSuuyiaU8Y4fORsEIXlbZTCBhSRu0wORLwUSc1noe9e8gHOinbUmRnnxgoxDNg2hMGpRiPy7+Ql/oKwxWTAwSYU2zRvidvO34T5khQl8LrRTnEa311jrk47xZVMRSyqi/hQwdjrJ195TokKLnPFWPmy+686xeciKo+uVXNdq82AWwHuUI9QXItmu9887J3wJUYw01UWrK8JLBE4oChxT9g/c3/FGhpbuu4bq3dFXU3n3yvjmi1FhBDIzTExOz2ozmSzkRV2Hv4Y9I+XWwVIO7aZ1fkmc9a+b7UW4VZEOKdW6yO4TDU3pRyGfIJqRDCTZOtdDuHS0dXBYbzxABfiqoqvlL9J9gislovA0DZ/c3T9vYKDeqURjhX7yP7JUbwex1LqFi+NKvljtXyvJV/h9FDAMtB60xW9/mBUHMf8+83YDQ8QCDzXpo22RcFI73VqM7MDV6GK04H5MZhGhDBoF7YhkSuuusaOLoz9cVHCuNb5D5+VNrLXwOsrDexCAgwbI8ckeMarrZjxC+U+TjmqnE0uiMo0bnxyOxA77roieNwgxxwLUql9LceVKqrEgQUaKQPyqAqaX/ftTX6Eul2grzDQuSuvcX/ueNce9c+I2125fmMCtcJRSzzYyvEHV5yGJ0NeqMNgXRxFt3dIbr7YZEThlxxY3kixEtjZL964FxEOUcO5qJZ2aNYUopkVqhuppYlQxMmPenHhWhu5H4KEaNCToSVdS+zIr5ID2tLZZSHTo96aca8TTGzCYVeXh8pyC3+zGZLWy0rSlGIl7VzB3zkKDtlpdsgNSEVWc0j21RHNEehYoT9yCjGYB1J3ofa7pInlDN8s4q2NXubeLo7RFTr21xRgUK8pmhWAdmz97kmjeMObMrTCQmt3iHNE2e5gTUpurSPmmwOM0O7jOI3rNiP3GnKW+cY7o9fx6PkN160BxWcJVFcQtKrSOuZI1aDFutIgibdDqE4Ih2s59JelE0wIFDaWHhOohPLESr8nm2iuhTa5fpgZyL8ukJvEtNYcFdMb/UagT6GXHq3wfrqQVMsTN5RcxaFXFpvocCAynY5kiJ8QyMu1/JZxrs82CKe3yG8XtvzogQSImsuBRK0mUqJi4fzIllzVU5vxFIZVMmiLVfoIx2pgh0r10aViXPBpJWvE8dfbUYHMskFXMxE5pI2Twx7HY6cBWZcPZxpnzSp5YVx7jSs4d19ThOmWeIUhhmcJGNdf5hTs10vK87YLXvhelWiW4ObA3axIfT3tQ73WJrzg9pLNzIJNEyesPV5kCZOqptqU4V3rG6V3Kneq5j3Skb6DAsyBKVhNkdUMtcqxS1oJQSEUTHsZvowrWKThMs5bc6gI/2yyTVV+XevA1HL2Al1gzwoj5DgyIC7rksHabQiLHC8yuQ59GRfj7lk0vdpvZPwenEUPC+f8MyBEC2jmNQ8Sf5D+AvdqD/Ke+sOVg6KSR9tVddNXnWaaNM7BKwvGYhlL3k5g/Vf8OKqILBzDskJx6RG8gOXQ7WSA5CXNrOmZJhGIjiEtj3sLZKWpLykLek2Rm8zbHELz1skoxP7auV/uQM84DZKeHdo21TlO8vxB8++gZ0yA+8WDYcoDPzRmXKpgjlEXCGC3QRnpogJqjOgUtMAQRfZ7elRZTlq89hZMVCQDineCI6HzsKclRP1p7YeSONJ5nCUeOZliZcqezGvpG03eRZ+ylKtaq/Pvyv2Y9wd7X3GWomarqKWeMR16HyPuY5EzglhbKKdxO+T16HXXeKDnrXytS2bwUKTsscPE2nofVRxYrD7d9hOhsuv6y//QxhOU2cU2TluR5KSU3Cus1bVDTwLYE/otIDcGQUt8yg67ulEIvCJGvn71BMhLZ3v0eAJxuYjEnYsZvuCSPl1VX8W0n+iAUv4Cdl1kTFkKo/my0t5MFNKcJSKSEHkBrpdwp6UNmhvYgNyNKpjMKpkhA8xNyLJgPqk01VRFFaKEh9j0OSrFD/5cPlQ3tFQQnIJVqxY6LFhT1lvGvH2XE9jNoaotEkdIyXqDIr3oy3m23CPFGEktE7gLqZhAyL2pMa2+fOWAmwCKCeDRc+xePxlLtcXjOXyIomPjEkWSDVFt1dRd4gehOaCZFDaPGK8iDvIQqqYmt5irlfQS5q79mht8bO2xQ3uanZHLMIQhXht8TKgJ7MllBgS7GnkZA0EtrLJRm24h1vLwKaA7jReCz41aAZMRRWBswCTTk02aO4SCGe3DoFAahHoM4Q+Ko3yEqbb4ZhiH2E/7LZktXTcDUHPPilwRq+5/P72qezVMUg1YC7PZIggLn2junskT9L1kMhWvnUeXM5w+RRfplXuhyxOeu6ggs6nIVQnlJ95QgayGC1RLcTs85xG4Xs8dKCRVk7kohvWslMBMNuOoFOutzmnx9SDKHY5q/muVrMgxdH6Y5zPhbsgB7yl2gEF8jRJxPgWc5JWW5yBiHXDFVMy9r4jES8JMIqaB+dhBKJdE9DsoTM4qOD8ESP5lp5STE01onOTjeCv8wwDnrDzLoT0kysMh7DlIZoT0j4R1oK7quZYN17NsTDV9eDF4y4cHSERPCMPz1AkrpYLpWx9hJJNBAO2NU+yTdipOkqR/u8wo3OcfkghNM4hcSk0yOc82fW8vc19EGWMAAwPOI6QoTFhJi4h61vICQWPgWdDDtYY8OGKmTFBtroBsPJBGd2bY91RIb/w7IgLUadxTxRbrM/Cxw+Tf8CWWfWbVog/faU/4k/yq/whQd8SOZBAHN7MbxnDfaGgR4HWlwr6akc7V7cXhuJMIuMoeqEwyl3UgqruMo4tFZSbCot7bfvSmoYPSPsHnC5KfUMCciyIEYnzx4rYbc6OQ6U1MFaXKv4TR8PxAKLLAMFZwJEq3+2UJdqpkYPmWSe10FE1cZtmQnC3GLdTUNF2y/gEQyNmHR3usbZIwKsI+mNSBNjR51KfP1foj1HD81hKvaP3OxrUqkbS5pfw9iAdEP0rTYIl3M0lYhF0SfzasvC7wrg+7WHBL/KwXO6WcdONLiYJ8jAqzXi8cz7NtaBScG5m4TvFMjpnQ9SRet7KZkFoF5amGXN38qQjjfMzpV49VVkSpKa4c17/87wdJ2qh+s28y/bf4mtfK7D9/wyR39XjCXg7b0op+5VC5PX/VYj8lWzEOtlp3017ZtUyFk+/4jm1uAOKW3lYKzofK0EV42Zha/QWu+JXTRnoalYTXZwn0cxPgnaFA5nxQLbosHOyHiQ5cQ4VVoLmjm5CERsgDoKrNKqV0qhEHmCbR9kWgoiu4EnrTvfY8TUpFtjUlkaP7tVebaH05pEsUx2WALOgT4T8LGGgPn+ganbQGMiNCyQ4C9o612Mx2DCnHaIbR7WFhoDyhItiRTN5JtmUGSbb8RrpxCWOJPDHYxQ4NYgDjPVpaCvEYyN0K0UFDXfUOqLrnKEVN5qwMhnS6GBIXdS5eZTWSIE0CTILR6s4I1qAIvqIhS31S/IvUWM9KJwH8dX1B2I3tf198sfEhNGYbqk50ohKZbF1WstBm6mFqo9t1KEwDWmkad52K99jyXLG12qaCwfr0/cJhttsMs305YmiWg0rQbMdPmqGif7XoRKLl70UVK2S6fai3Tov/2/Fo6+WRv6METsXeGLFuLwkfr2Ufx6QGMK6yy3TaJqj2Xg3YfuACGem+bGa8zHNk9TXitExTaEhSLE91qx7pdOYPZrL6PH6RmUEcWQoY4MT5ZkCSeZUtseGv4FF58qoQ2LLVFzQp3NkoYnnbNKav4UYjO7itRuukwUzCxNoHG2HKlgP1fHio+eyTRWHqdjZDYJEUZeybJR1udsK8ZdWvtWhA2OUBTedTlKsJk0W0zOJAYBYVX14ng68zZ+dhGnzO44l77GjyjO1bqC6n2rifNiTelUHuQPTM4knJgsYuTpgzMxRorxb7sJDDm+WvWXmIMVi7ip3FyqprSQDVIcVv8tzG6k+CaKgfqPsdlLb9IVcGZAueyGo6SfMc4nIIPPzzIzMcROHPwL3jPIrS00UHmT97d3TNhMQYfWdlfgov37zFLnNd3AorwvxNn2t+aObbF+aJNVAjgwRDsr3heFVVdE2Dzeg8DuakKRe0jzTfEYUDUstPk3iyWSc/huxxx929LHM8vODBdmMw1159iyPhW41ZkRFY2zabicdyIfyY3babyDpr8zoouilQs4MLXyEeVmx/JBXE8t7SU/Po0B5kgwnYzNNd7YvKR4Zm7PHc2N4SXvzdE/SvMiXSKe/a9NMNvTVwV8P8jjPLpURTpqNXMwMzRfBtBm+daAhNyfywALdXz10QZ4bSrf1eDrggJWWEmWCfDVZOMcH3qYHq/awsC5ml7A7LbgITQG31Mb0xnLcrJhkntdk0pkndbnTWHaUX+GRk5DHj+e9XbF6n9XjHThLfPZbLx0+Nq8g5tHOxJTOXeDKMj9ftDgdhXhs7map+uobTubfl1+gLr88XV9W7uTkj1hbIcpnvPL6dPv5PZ48EF/UPZSMW09k6pBzUbaDhcO+XXyuLqqJo4cWP8HilFVNvYF8+/Mb+kgWXWO+jH6m04Wk/hrzH9W0FoZGFeUuxjG8ePJkz0u3zm+fvP35zZPb9umTtmqDovzSCCVIHbTPBdM4xdUH0ovmBK8/9yirdvH6LePSFMIl2Tv1qd+8/v7Vu/evRP5eETvXBh7Qy7kmc/54ldCVqsZZykd9Rt9DKgucuxclBKi5D1CmLPq+HlXmSYk4z1q4oRoaKd8FVab0N3n9mV9g/wuG9QVm9nl7wPlAIfkDrzlQvz37/5pQjFD8Dw==',
  },
  microsoftSdkLicense: {
    sourceURL: 'https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/1.0.3800.47/microsoft.web.webview2.1.0.3800.47.nupkg', entry: 'LICENSE.txt',
    sha256: '0af8f1b807512aae39c2ac1aa4d0cae65cabecb6fd554b8439a5162a0d6eca55',
    deflateBase64: 'pZJBb+M2EIXv/BUPe9oUQnrvnmhpbBGQRZWk4vVRseg1AUs0KDpB/n1Bxmm87QI99CRCHM68980r/eUtuB+niK/lA7buEPzijxGlDxcfhuj8/Ah+PiMXLQh2seHFjo+MKTu6JQb3fE1VGOYR18XCzVj8NRxs/vPs5iG84ejDtBR4dfEEH/LXXyOb/OiO7pDHFBiCxcWGycVoR1yCf3GjHRFPQ0Q8WRz9+exf3fwDBz+PLj1a0iM22fgHYwB+w8+iFvjjh5qDHy2m6xIRbBzcnFsOz/4lXd0gsNlHd7AF4sktOLslpgb30+bxH1JGtxzOg5tsePy1AjffQ/hQcAl+vB7spwj2twj8HxHsZmz0h+tk5zh87OZ3H+DjyQZMQ7TBDeflE3HeSzxZdi/95secLOZhsknEL/NRpI3GW1Um7uKS9L538mEBm4a3ZAvPNmVkRPSw8+jDYtPjS/CTjxbvUOKC0Qb3Ykccg58yBpaGvqaA3KKD5WIPKTu4BJcSFVJq5vf8LEuWz0wtNLRcmx1XBKHRKfkkKqqw2sPUhFJ2eyU2tUEtm4qUBm8rlLI1Sqx6I5VmX7iG0F/yBW/3oO+dIq0hFcS2awRV2HGleGsE6QKiLZu+Eu2mwKo3aKVhjdgKQxWMLPLQfz+DXGNLqqx5a/hKNMLs87y1MG2atZaKcXRcGVH2DVfoetVJTUi2KqHLhostVY8QLVoJeqLWQNe8aX52yeSuJZWk31vEitAIvmooDcomK6GoNMnN56kUFbWGNwXTHZWCNwXoO227hqt9ceup6c+eWiN4g4pv+YY0vv4HkU7Jsle0TZLlGrpfaSNMbwgbKavMWZN6EiXpb2ikzrB6TQWruOF5cKfkWhj9LZ1XvRaZmWgNKdV3Rsj2AbXc0RMplLzXVGW4sk1WmalJqn1qmhhk9gV2NZmaVOKZSfGEQBslSnNfJhWMVIZ9ekRLm0ZsqC0p3crUZSc0PYAroVOByGOx43vIPltOK+o1sXy8C2yRFwmxBq+eRJJ9K+6k1uIWk4ysrG+4H/8C',
  },
  microsoftSdkNotice: {
    sourceURL: 'https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/1.0.3800.47/microsoft.web.webview2.1.0.3800.47.nupkg', entry: 'NOTICE.txt',
    sha256: '106423785c5b7eba0a8e61d1837f2132e9c828e20ad530f565d981c1df60dd90',
    deflateBase64: '7VZRb9s2EH7nrzgUA9oCjps0LbC2T7RExwRkySOppMEwoLJ0iblKpEfS6bJfP5xsN8n6WOwteYlAHo/ffd93PJeVkZnQwMscZDmv1JIbWZUs91D6BCY0LvZNQvABCt82vf0HGTMbGyH6m/StCQjWtT5sfWgSRhiahME2PdwEP0Da2NDBtgnJYpzC0rbB0zkYmq8YocWQGuuY36KD6HehRWh9h9DcNbZv1j1Ck2CT0jZ+fPPmPHSU6X4fOB2OyaatHyYE8N7vYGjuWUTXQQPtBtuvtD54h/fgQ4cBbnyAWsMv76enpxOC3u86624hbRC2wXe7NoFrBpyMKwSMfQc2bL1Dd9xvXAd3GKL1DtxuWGOYQPIfGdP7+IwKyfyw7W3jWgSDzcAeGMgOnFnvWOXwETdXzT1T2A3edRO44vDh19P3b1mtOWOlT99s2sTUuBF14+7Bpw0GSBiGODlSAAEJGgK6W+uQ9p9IljyVx/DvRPUE/GtnA3a03OF6dwvtpnG3GGmBrujtOjTBYoTetugidrBz3ZgV4aKsocAYMbALdBiaHla7dW9bKPbBU8ZOfvKPMe5SH86naueSHRDOp++nb09CewYnMNM5nJ9kfbOLyNjvZoPwgtYOWF/8wTK/vQ/2dpPgVfsa3p6enQFF8dIUClbB/4ltYrzvYQyKEDBiuMNuykgIG1Ow6x0pNYq+i+T5o19pZW1dE+7JW6QBKUS2o/9+l9jgO3tj21HqCRD9WwyDTQk7styd7Yj6TZNGOm983/tvJG7rXWfpUGR0aMD0kTE4m8JTTBH8zZPmGXaRNKXOGjM2a39HWwcOGACA88m2o8ktiRoTJXm4cKzqKZrOxrZv7IBhyuDtjyCse0zDEcS+pfB/wQH7+sY8nW93A7rUHFV648OhM44vUnwge1SI0j4uYcrgfAol2n0/bXDsc8JD399hw8b3ZH3nH4JGCWyKI5TWu31OH+LYi2sky4zdha7z1JY+EJjBp++PToQOg73Dbnw4x0RPW/bgJohbbMlOsA2WTBbISG5vqRjHOphZSA26mpsrrgRIDStVXcpc5DC7BrMQwGuzqBR8+cI1SP3y5fj+8/IaxOeVElpDpZhcrgopcrjiSvHSSKEnIMusqHNZXkxgVhsoKwOFXEojcjDVZEz94zFWzWEpVLbgpeEzWUhzPd43l6aku+aVAg4rrozM6oIrWNVqVWkBBD6XOiu4XIp8ymQJZQXiUpQG9IIXxeNaZgIKyWeF2OcrryGXSmSGQB++mCwzmYvS8GICeiUySR/is1iuCq6uJ1ApyKpSi99qURrJC8j5kl8IDa+eFs7+W/hKVVmtxJKQVXPQ9UwbaWoj4KKqcqITtFCXNGo/QVERwXOotZiwnBs+XrxS1Vwa/Ym+Z7WWIzWyNEKpekUz+TUsqitxKRRkvNYiHzmsSiqVmYWo1DUlJQ5GiidwtRBmIRTIkqoyihMZ2iiZmcdhlQJTKcMeaoRSXBTyQpSZoN2KslxJLV4DV1JTgByvhSt+DVU9lkxK1FpANX/qvsmoF8g58PxSEuxD8KrSWh7cMFKWLQ50/8y8+KmjOgXrbg0OW/rJ8w7eTU+nH56HzPOQeR4yz0Pmecg8D5njpPgX',
  },
};
const SUPPLEMENTS = {
  'alloc-stdlib@0.3.0': { key: 'dropbox', revision: '0a81fd6928ea3b33c8cd484aa4575d50ffb98012', file: 'LICENSE', explanation: 'Repository-root license at the exact packaged source revision covers the alloc-stdlib subdirectory.' },
  'clipboard-win@5.4.3': { key: 'clipboard', revision: 'ed27008ae5d1f10cfbb266de039f0fb35fd05a56', file: 'LICENSE', explanation: 'Repository-root license from the exact packaged source revision.' },
  'webview2-com@0.39.1': { key: 'webviewRust', revision: 'edc2caf886175ccaebe86078c9cfe1ae2a187328', file: 'LICENSE', explanation: 'MIT workspace license from the exact packaged source revision; does not replace native Microsoft SDK terms.' },
  'webview2-com-sys@0.39.1': { key: 'webviewRust', revision: 'edc2caf886175ccaebe86078c9cfe1ae2a187328', file: 'LICENSE', explanation: 'MIT workspace license from the exact packaged source revision; native Microsoft SDK terms are retained separately.' },
  'webview2-com-macros@0.8.1': { key: 'webviewRust', revision: 'dffa41a8a46d3f5565eefbff2de57d38d399f158', file: 'LICENSE', sourceURL: 'https://raw.githubusercontent.com/wravery/webview2-rs/dffa41a8a46d3f5565eefbff2de57d38d399f158/LICENSE', explanation: 'MIT workspace license from the exact packaged source revision; both pinned upstream commits contain identical original license bytes.' },
  'selectors@0.38.0': { key: 'mpl', revision: '572ecba2d1600e7c3d490586692a209faf703baa', file: 'LICENSE-MPL-2.0.txt', explanation: 'Canonical Mozilla license-steward text. The exact packaged lib.rs explicitly incorporates MPL 2.0 and points to https://mozilla.org/MPL/2.0/. This is the referenced original license, not a template inferred from SPDX or borrowed from another crate.' },
};
const WEBVIEW_SDK = {
  version: '1.0.3800.47',
  packageSha256: '56c9f26bdd07916a2d1949fb58a5c7e434dfa1173577dca879206050c4e718db',
  provenanceURL: 'https://raw.githubusercontent.com/wravery/webview2-rs/edc2caf886175ccaebe86078c9cfe1ae2a187328/crates/update-bindings/src/main.rs',
  loaders: {
    x64: '89c6b872783b8f6c3cedbff618adb42082d455c615453ae10cfc753f1e8f25d8',
    x86: '0513f7e61304321f2d91e1851475be07e091042aa3640597e660608f72521e6c',
    arm64: '4a1ca4b518337c508aa0d778b220c6e59558fce21f4fd0d79a6ea944dd9d5208',
  },
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GENERATOR = 'QGitGraph/scripts/generate-notices.mjs';
const SCHEMA = 1;
const INDEX = 'THIRD_PARTY_NOTICES.md';
const MANIFEST = 'notices/manifest.json';
const MARKER = `<!-- Generated by ${GENERATOR}; do not edit generated files. -->`;
const args = process.argv.slice(2);
let target = 'x86_64-pc-windows-msvc';
let check = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--check') check = true;
  else if (args[i] === '--target' && args[i + 1]) target = args[++i];
  else if (args[i] === '--help') {
    console.log('node scripts/generate-notices.mjs [--check] [--target x86_64-pc-windows-msvc]\nOffline only; no installs/builds. --check compares generated bytes; it is not legal clearance.');
    process.exit(0);
  } else throw new Error(`Unsupported argument: ${args[i]}`);
}
if (!/^(x86_64|aarch64|i686)-pc-windows-msvc$/.test(target)) throw new Error('Only Windows MSVC targets are supported.');

const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sha = data => createHash('sha256').update(data).digest('hex');
const json = data => `${JSON.stringify(data, null, 2)}\n`;
const md = value => String(value ?? 'UNKNOWN').replace(/[\r\n]+/g, ' ').replace(/\|/g, '&#124;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const slash = value => value.split(path.sep).join('/');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const outputs = new Map();
const issues = [];
const inventory = [];

function verifiedText(key) {
  const item = VERIFIED_UPSTREAM_TEXT[key];
  if (!item) throw new Error(`Missing official text snapshot: ${key}`);
  const bytes = inflateRawSync(Buffer.from(item.deflateBase64, 'base64'));
  if (sha(bytes) !== item.sha256) throw new Error(`Official text snapshot hash mismatch: ${key}`);
  return { ...item, bytes };
}
function packageVcs(root) {
  const file = path.join(root, '.cargo_vcs_info.json');
  const stat = lstat(file);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe packaged VCS metadata: ${file}`);
  const info = readJson(file);
  return { revision: info.git?.sha1 ?? null, pathInRepository: info.path_in_vcs ?? null };
}
function supplementalFiles(data, root, directory, packageId, vcs) {
  const result = [];
  const entry = data.ecosystem === 'cargo' ? SUPPLEMENTS[`${data.name}@${data.version}`] : null;
  if (!entry) return result;
  if (vcs?.revision !== entry.revision) {
    issue('UNKNOWN_UPSTREAM_LICENSE_REVISION', packageId, 'Pinned official license supplement does not match the installed source revision; it was not applied.');
    return result;
  }
  if (data.name === 'selectors') {
    const header = fs.readFileSync(path.join(root, 'lib.rs'), 'utf8').slice(0, 1000);
    if (!header.includes('https://mozilla.org/MPL/2.0/') || !header.includes('License, v. 2.0')) throw new Error('selectors official MPL supplement lacks expected original source reference.');
  }
  const text = verifiedText(entry.key);
  const output = `${directory}/upstream/${entry.file}`;
  add(output, text.bytes);
  result.push({ output, sourceURL: entry.sourceURL ?? text.sourceURL, sha256: text.sha256, bytes: text.bytes.length,
    revision: entry.revision, explanation: entry.explanation, fullLicenseText: true });
  if (data.name === 'webview2-com-sys') {
    const arch = target.startsWith('x86_64') ? 'x64' : target.startsWith('aarch64') ? 'arm64' : 'x86';
    const loader = fs.readFileSync(path.join(root, arch, 'WebView2LoaderStatic.lib'));
    if (sha(loader) !== WEBVIEW_SDK.loaders[arch]) {
      issue('UNKNOWN_NATIVE_WEBVIEW2_LOADER_VERSION', packageId, 'Native loader hash differs from the verified Microsoft SDK package; pinned SDK terms were not applied.');
    } else {
      for (const key of ['microsoftSdkLicense', 'microsoftSdkNotice']) {
        const sdkText = verifiedText(key);
        const sdkOutput = `${directory}/upstream/Microsoft.Web.WebView2-${WEBVIEW_SDK.version}-${sdkText.entry}`;
        add(sdkOutput, sdkText.bytes);
        result.push({ output: sdkOutput, sourceURL: sdkText.sourceURL, archiveEntry: sdkText.entry,
          sha256: sdkText.sha256, bytes: sdkText.bytes.length, sourcePackageSha256: WEBVIEW_SDK.packageSha256,
          provenanceURL: WEBVIEW_SDK.provenanceURL, verifiedNativeLoader: { file: `${arch}/WebView2LoaderStatic.lib`, sha256: sha(loader) },
          explanation: 'Original Microsoft NuGet SDK LICENSE/NOTICE. The exact upstream updater names this SDK version and its static loader matches the installed crate byte-for-byte. SDK notices are conservatively retained in full, including ANTLR copyrights; no claim that all SDK components ship. These terms do not describe the separately installed WebView2 runtime/bootstrapper.',
          fullLicenseText: key === 'microsoftSdkLicense' });
      }
    }
  }
  return result;
}
function sourceArchive(data, root, packageId) {
  if (data.ecosystem !== 'cargo' || !/\bMPL-2\.0\b/.test(data.license ?? '')) return null;
  // Manifest path is .../registry/src/<registry>/<crate>/Cargo.toml.
  const registryHashDirectory = path.dirname(root);
  const srcDirectory = path.dirname(registryHashDirectory);
  const registry = path.dirname(srcDirectory);
  if (path.basename(srcDirectory) !== 'src' || path.basename(registry) !== 'registry') {
    issue('UNKNOWN_MPL_SOURCE_ARCHIVE', packageId, 'Cannot locate a standard registry source/cache pair; source archive unavailable.');
    return null;
  }
  const actualArchive = path.join(registry, 'cache', path.basename(registryHashDirectory), `${data.name}-${data.version}.crate`);
  const archiveStat = lstat(actualArchive);
  if (!archiveStat?.isFile() || archiveStat.isSymbolicLink()) {
    issue('UNKNOWN_MPL_SOURCE_ARCHIVE', packageId, 'No local, regular Cargo registry .crate source archive was available.');
    return null;
  }
  const bytes = fs.readFileSync(actualArchive);
  const checksum = lockedCargoChecksums().get(`${data.name}@${data.version}`);
  if (!checksum || sha(bytes) !== checksum) throw new Error(`MPL source archive does not match Cargo.lock checksum: ${packageId}`);
  const output = `notices/sources/${data.name}-${data.version}.crate`;
  add(output, bytes);
  return { output, sha256: checksum, bytes: bytes.length,
    sourceURL: `https://static.crates.io/crates/${data.name}/${data.name}-${data.version}.crate`,
    description: 'Original locked Cargo source archive, copied unchanged and checksum-verified; no application source is relicensed.' };
}
let cargoChecksums;
function lockedCargoChecksums() {
  if (!cargoChecksums) {
    cargoChecksums = new Map();
    const text = fs.readFileSync(path.join(ROOT, 'src-tauri', 'Cargo.lock'), 'utf8');
    for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
      const name = /^name\s*=\s*"([^"\r\n]+)"/m.exec(block)?.[1];
      const version = /^version\s*=\s*"([^"\r\n]+)"/m.exec(block)?.[1];
      const checksum = /^checksum\s*=\s*"([a-f0-9]{64})"/m.exec(block)?.[1];
      if (name && version && checksum) cargoChecksums.set(`${name}@${version}`, checksum);
    }
  }
  return cargoChecksums;
}

function relativePath(value) {
  if (typeof value !== 'string' || value.includes('\\') || value.includes('\0') || path.posix.isAbsolute(value)
    || value.split('/').some(s => !s || s === '.' || s === '..' || /[\u0000-\u001f\u007f:<>"|?*]/.test(s) || /[. ]$/.test(s))) {
    throw new Error(`Unsafe generated path: ${value}`);
  }
  if (value !== INDEX && !value.startsWith('notices/')) throw new Error(`Path outside owned outputs: ${value}`);
  return value;
}
function destination(relative) {
  relativePath(relative);
  const absolute = path.resolve(ROOT, ...relative.split('/'));
  if (!absolute.startsWith(`${ROOT}${path.sep}`)) throw new Error(`Path escapes project: ${relative}`);
  return absolute;
}
function lstat(file) {
  try { return fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function regularFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`Refusing non-regular, linked, or shared output file: ${file}`);
}
function noLinkedParents(relative) {
  let current = ROOT;
  for (const part of relative.split('/').slice(0, -1)) {
    current = path.join(current, part);
    const stat = lstat(current);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`Refusing linked/non-directory output parent: ${current}`);
  }
}
function add(relative, data) {
  relativePath(relative);
  if (outputs.has(relative)) throw new Error(`Duplicate output: ${relative}`);
  outputs.set(relative, Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'));
}
function dirsOf(files) {
  const dirs = new Set(['notices']);
  for (const relative of files) {
    let parent = path.posix.dirname(relative);
    while (parent !== '.') { dirs.add(parent); parent = path.posix.dirname(parent); }
  }
  return dirs;
}

// An ownership manifest plus hashes is required even for an existing empty
// notices directory. Unknown/edited files, symlinks, junctions, and hardlinks
// are never adopted or overwritten. No recursive directory deletion is used.
function inspectOwnedOutput() {
  const stat = lstat(path.join(ROOT, 'notices'));
  if (!stat) {
    if (lstat(path.join(ROOT, INDEX))) throw new Error(`Refusing existing unowned ${INDEX}. Move it aside explicitly first.`);
    return null;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Refusing linked/non-directory notices output.');
  const manifestPath = destination(MANIFEST);
  if (!lstat(manifestPath)) throw new Error('Refusing existing notices directory without this generator\'s ownership manifest (including an empty directory).');
  regularFile(manifestPath);
  const previous = readJson(manifestPath);
  if (previous.generator !== GENERATOR || previous.schemaVersion !== SCHEMA || !previous.ownedFiles
    || typeof previous.ownedFiles !== 'object' || Array.isArray(previous.ownedFiles)) throw new Error('Unrecognized notices ownership manifest.');
  const owned = Object.keys(previous.ownedFiles);
  if (!owned.includes(INDEX) || owned.includes(MANIFEST)) throw new Error('Invalid ownership manifest.');
  for (const relative of owned) {
    relativePath(relative);
    noLinkedParents(relative);
    if (!/^[a-f0-9]{64}$/.test(previous.ownedFiles[relative])) throw new Error(`Invalid ownership hash: ${relative}`);
    regularFile(destination(relative));
    if (sha(fs.readFileSync(destination(relative))) !== previous.ownedFiles[relative]) throw new Error(`Refusing modified generated file: ${relative}`);
  }
  const allowed = new Set([...owned, MANIFEST]);
  const dirs = dirsOf(allowed);
  function walk(relative) {
    for (const entry of fs.readdirSync(path.join(ROOT, ...relative.split('/')), { withFileTypes: true })) {
      const name = `${relative}/${entry.name}`;
      relativePath(name);
      const item = fs.lstatSync(destination(name));
      if (item.isSymbolicLink()) throw new Error(`Refusing linked output: ${name}`);
      if (item.isDirectory()) {
        if (!dirs.has(name)) throw new Error(`Refusing unowned output directory: ${name}`);
        walk(name);
      } else {
        if (!allowed.has(name)) throw new Error(`Refusing unowned output file: ${name}`);
        regularFile(destination(name));
      }
    }
  }
  walk('notices');
  return previous;
}

function inputHashes() {
  return Object.fromEntries(['package.json', 'package-lock.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']
    .map(relative => [relative, sha(fs.readFileSync(path.join(ROOT, ...relative.split('/'))))]));
}
function assertInputs(hashes) {
  if (json(inputHashes()) !== json(hashes)) throw new Error('Dependency inputs changed during collection; rerun without concurrent dependency updates.');
}
function issue(code, packageId, message) { issues.push({ code, package: packageId, message }); }
function licenseExpression(value) {
  if (typeof value === 'string' && value.trim()) return value;
  if (value && typeof value.type === 'string') return value.type;
  return null;
}
function declaredPeople(value) {
  return (Array.isArray(value) ? value : value ? [value] : []).map(person => typeof person === 'string' ? person
    : [person.name, person.email ? `<${person.email}>` : ''].filter(Boolean).join(' ')).filter(Boolean);
}
function sourceFile(root, relative) {
  if (path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(s => !s || s === '.' || s === '..')) throw new Error(`Unsafe dependency file path: ${relative}`);
  const file = path.resolve(root, ...relative.split('/'));
  const real = fs.realpathSync(file);
  if (path.relative(root, real).startsWith('..') || path.isAbsolute(path.relative(root, real))) throw new Error(`Dependency file escapes package: ${relative}`);
  return file;
}

const legalName = /(?:^|[-_. ])(?:licen[cs]es?|copying|notices?|copyrights?|authors?|unlicense|patents?)(?:$|[-_. ])/i;
const licenseName = /(?:^|[-_. /])(?:licen[cs]es?|copying|unlicense)(?:$|[-_. /])/i;
const headerSignal = /copyright|SPDX-License-Identifier|licensed under|permission (?:is hereby|to use)|this source code form|mozilla public license/i;
const sourceExtension = /\.(?:rs|js|cjs|mjs|ts|tsx|jsx|c|h|cc|cpp|hpp|css|html|py|sh|ps1|md|txt|rst)$/i;
function legalFiles(root, packageId, declaredLicenseFile) {
  const files = new Map();
  const headers = [];
  let visited = 0;
  function walk(dir, prefix = '', legalDirectory = false) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => cmp(a.name, b.name))) {
      if (['.git', 'node_modules', 'target'].includes(entry.name)) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (++visited > 100000) throw new Error(`Too many dependency files: ${packageId}`);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        issue('UNSCANNED_SYMLINK', packageId, `Skipped dependency symlink: ${relative}`);
        continue;
      }
      if (stat.isDirectory()) { walk(full, relative, legalDirectory || legalName.test(entry.name)); continue; }
      if (!stat.isFile()) continue;
      if (legalDirectory || legalName.test(entry.name)) {
        if (stat.size > 8 * 1024 * 1024) { issue('UNSCANNED_LEGAL_FILE', packageId, `Legal file exceeds safety limit: ${relative}`); continue; }
        files.set(relative, fs.readFileSync(full));
      } else if (sourceExtension.test(entry.name)) {
        // Read only a prefix. Copy comment blocks, never implementation code.
        const fd = fs.openSync(full, 'r');
        let prefixBytes;
        try { const buffer = Buffer.alloc(32768); const length = fs.readSync(fd, buffer, 0, buffer.length, 0); prefixBytes = buffer.subarray(0, length); }
        finally { fs.closeSync(fd); }
        if (prefixBytes.includes(0)) continue;
        const text = prefixBytes.toString('utf8');
        const matches = text.matchAll(/\/\*[\s\S]*?\*\/|^[ \t]*\/\/[^\n]*(?:\n[ \t]*\/\/[^\n]*)*/gm);
        for (const match of matches) {
          if (headerSignal.test(match[0])) headers.push({ source: relative, text: match[0] });
        }
      }
    }
  }
  walk(root);
  if (declaredLicenseFile) {
    try {
      const resolved = path.resolve(root, declaredLicenseFile);
      const relative = slash(path.relative(root, resolved));
      const file = sourceFile(root, relative);
      if (!fs.statSync(file).isFile() || fs.statSync(file).size > 8 * 1024 * 1024) throw new Error('not a regular legal file within safety limit');
      files.set(relative, fs.readFileSync(file));
    } catch (e) { issue('MISSING_DECLARED_LICENSE_FILE', packageId, `Declared license_file could not be collected safely: ${declaredLicenseFile} (${e.message})`); }
  }
  return { files: [...files].sort(([a], [b]) => cmp(a, b)), headers };
}

function collectPackage(data) {
  const packageId = `${data.ecosystem}:${data.name}@${data.version}`;
  const slug = `${data.name.replace(/[^a-zA-Z0-9_.-]/g, '_')}-${data.version.replace(/[^a-zA-Z0-9_.-]/g, '_')}-${sha(data.identity).slice(0, 10)}`;
  const directory = `notices/${data.ecosystem}/${slug}`;
  const root = fs.realpathSync(data.root);
  const vcs = packageVcs(root);
  const supplements = supplementalFiles(data, root, directory, packageId, vcs);
  const sources = sourceArchive(data, root, packageId);
  const { files, headers } = legalFiles(root, packageId, data.licenseFile);
  const copied = files.map(([source, bytes], i) => {
    const basename = path.posix.basename(source).replace(/[^a-zA-Z0-9_.-]/g, '_');
    const output = `${directory}/files/${String(i + 1).padStart(3, '0')}-${basename}`;
    add(output, bytes);
    return { source, output, sha256: sha(bytes), bytes: bytes.length };
  });
  // This is a collection status, not SPDX interpretation or legal validation.
  const substantiveLicense = files.some(([file, bytes]) => licenseName.test(file) && bytes.length > 300) || supplements.some(f => f.fullLicenseText);
  const status = substantiveLicense ? 'FILES_COLLECTED_NOT_LEGALLY_VERIFIED' : 'UNKNOWN_MISSING_FULL_LICENSE_TEXT';
  if (!substantiveLicense) issue('UNKNOWN_MISSING_FULL_LICENSE_TEXT', packageId,
    `No substantive standalone LICENSE/COPYING text was found in the installed package. Declared expression: ${data.license ?? 'UNKNOWN'}. Original source headers, if found, are retained but are not a substitute for the full terms.`);
  if (!data.license) issue('UNKNOWN_LICENSE_DECLARATION', packageId, 'No license expression was declared; do not infer one from author names or another package.');
  if (/\b(?:MPL|GPL|AGPL|LGPL|EUPL|CDDL)(?:-|\b)/.test(data.license ?? '')) issue('SOURCE_AVAILABILITY_REVIEW', packageId,
    sources ? 'Exact locked source archive is supplied with this notices tree and a recipient-facing source-availability guide. Confirm the release includes both, preserves source terms, and that no patched covered files differ from this version. This does not select MPL for application files or establish legal clearance.'
      : 'Review source-availability/copyleft obligations for actual shipped code. Identify covered source/version and modifications, supply required recipient-facing access/offer, and preserve notices. No source archive was collected for this package.');
  let headersOutput = null;
  if (headers.length) {
    headersOutput = `${directory}/SOURCE_HEADERS.txt`;
    add(headersOutput, `Generated attribution/comment excerpts for ${packageId}\nSource: locked, locally installed package. Comment text below is copied without editing.\nThese excerpts are NOT a substitute for missing full license terms.\n\n${headers.map(h => `===== ${h.source} =====\n${h.text}\n`).join('\n')}`);
  }
  const embedded = [];
  if (data.ecosystem === 'npm' && data.name === '@tauri-apps/api') {
    const tslib = headers.filter(h => /^external\/tslib\//.test(h.source) && /Copyright \(c\) Microsoft Corporation/.test(h.text) && /Permission to use, copy, modify/.test(h.text));
    if (tslib.length) {
      for (const [i, entry] of tslib.entries()) {
        const output = `${directory}/embedded/tslib-${i + 1}-permission.txt`;
        add(output, entry.text);
        embedded.push({ name: 'tslib (vendored helper)', version: null, source: entry.source, output,
          license: 'Original Microsoft permission/warranty text retained; no standalone version or SPDX identifier inferred.' });
      }
    } else issue('UNKNOWN_VENDORED_TSLIB_PERMISSION', packageId, 'Expected bundled tslib permission header was not found; inspect the installed package before distribution.');
  }
  if (data.ecosystem === 'cargo' && data.name === 'webview2-com-sys') issue('NATIVE_WEBVIEW2_RUNTIME_REVIEW', packageId,
    'The exact native SDK loader LICENSE.txt and NOTICE.txt are retained after loader hash verification. The separately installed/downloaded WebView2 runtime/bootstrapper and any MSVC runtime redistribution have distinct terms; verify the installer behavior and applicable Microsoft notices. No permission is inferred from the Rust MIT declaration.');
  const record = {
    ecosystem: data.ecosystem, name: data.name, version: data.version, identity: data.identity,
    source: data.source, repository: data.repository ?? null, declaredAuthors: data.authors ?? [],
    declaredLicense: data.license, relationship: data.relationship, collectionStatus: status,
    vcs, notice: `${directory}/NOTICE.md`, legalFiles: copied, upstreamLegalFiles: supplements, sourceArchive: sources, sourceHeaders: headersOutput, embeddedComponents: embedded,
  };
  const lines = [MARKER, '', `# ${md(packageId)}`, '',
    `- Declared license expression (not a license grant by this app): ${md(data.license)}`,
    `- Collection status: ${status}`,
    `- Dependency relationship: ${md(data.relationship)}`,
    `- Locked source: ${md(data.source)}`,
    `- Repository declared by package: ${md(data.repository)}`,
    `- Declared authors/contributors (NOT inferred copyright holders): ${(data.authors ?? []).map(md).join('; ') || 'Not declared'}`,
    ...(vcs ? [`- Packaged source revision: ${md(vcs.revision)}; repository subpath: ${md(vcs.pathInRepository)}`] : []), '',
    'Copyright holders and permission/warranty terms are retained in the original files and source-comment excerpts below. No license text is synthesized or borrowed from another package. All license alternatives found are retained without choosing a license for the application.', '',
    '## Original legal files (byte-for-byte copies)', '',
    ...(copied.length ? copied.map(f => `- [${md(f.source)}](files/${path.posix.basename(f.output)}) — SHA-256 \`${f.sha256}\``) : [supplements.length ? 'No standalone text shipped in the registry package. Verified original upstream text is supplied below.' : '**UNKNOWN: no standalone legal files found in the locally installed package.**']), '',
    ...(supplements.length ? ['## Verified official upstream legal text', '',
      ...supplements.map(f => `- [${path.posix.basename(f.output)}](upstream/${path.posix.basename(f.output)}) — SHA-256 \`${f.sha256}\`\n  - Original source: ${f.sourceURL}${f.archiveEntry ? ` (archive entry ${f.archiveEntry}; package SHA-256 ${f.sourcePackageSha256})` : ''}\n  - ${md(f.explanation)}${f.provenanceURL ? `\n  - SDK-version provenance: ${f.provenanceURL}; verified installed loader ${f.verifiedNativeLoader.file} SHA-256 ${f.verifiedNativeLoader.sha256}.` : ''}`), ''] : []),
    ...(sources ? ['## Covered third-party source availability', '',
      `Original unmodified locked Cargo source archive: [${data.name}-${data.version}.crate](${path.posix.relative(directory, sources.output)}). SHA-256: \`${sources.sha256}\`.`,
      `Public copy: ${sources.sourceURL}`, '[Source access and terms](../../source-availability.md). This applies to covered third-party files, not unrelated application source.', ''] : []),
    ...(headersOutput ? ['## Original source attribution/license comments', '', '[SOURCE_HEADERS.txt](SOURCE_HEADERS.txt) (comment excerpts, not implementation code).', ''] : []),
    ...(embedded.length ? ['## Bundled third-party helper', '', ...embedded.map(e => `- ${md(e.name)}; version UNKNOWN/not separately declared. [Original permission comment](embedded/${path.posix.basename(e.output)}) from ${md(e.source)}. ${md(e.license)}`), ''] : []),
    '## Review findings', '',
    ...issues.filter(i => i.package === packageId).map(i => `- **${i.code}**: ${md(i.message)}`),
  ];
  if (!issues.some(i => i.package === packageId)) lines.push('No automated missing-text flag. This is not a conclusion about legal compliance or complete binary attribution.');
  add(record.notice, `${lines.join('\n')}\n`);
  inventory.push(record);
}

function npmPackages() {
  const pkg = readJson(path.join(ROOT, 'package.json'));
  const lock = readJson(path.join(ROOT, 'package-lock.json'));
  if (![2, 3].includes(lock.lockfileVersion) || !lock.packages?.['']) throw new Error('package-lock v2/v3 with a packages map is required.');
  for (const field of ['dependencies', 'optionalDependencies']) {
    if (json(pkg[field] ?? {}) !== json(lock.packages[''][field] ?? {})) throw new Error(`package.json and package-lock root ${field} differ.`);
  }
  const selected = new Set();
  function resolve(from, name, optional = false) {
    if (!/^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/.test(name)) throw new Error(`Unsafe npm dependency name: ${name}`);
    let ancestor = from;
    while (true) {
      const candidate = `${ancestor ? `${ancestor}/` : ''}node_modules/${name}`;
      if (lock.packages[candidate]) return candidate;
      const index = ancestor.lastIndexOf('/node_modules/');
      if (!ancestor) break;
      ancestor = index >= 0 ? ancestor.slice(0, index) : '';
    }
    if (optional) return null;
    throw new Error(`Production npm dependency not found in lock: ${name}`);
  }
  function visit(key) {
    if (!key || selected.has(key)) return;
    relativePath(`notices/${key}`);
    const locked = lock.packages[key];
    if (locked.link) throw new Error(`Linked npm production package requires explicit review: ${key}`);
    const installedPath = path.join(ROOT, ...key.split('/'));
    if (!lstat(installedPath)) {
      issue('UNKNOWN_UNINSTALLED_NPM_PACKAGE', `npm:${key}`, 'Locked production/optional dependency is not installed; no license text was available.');
      return;
    }
    if (fs.lstatSync(installedPath).isSymbolicLink()) throw new Error(`Refusing linked npm package: ${key}`);
    const real = fs.realpathSync(installedPath);
    const nodeModules = fs.realpathSync(path.join(ROOT, 'node_modules'));
    if (!real.startsWith(`${nodeModules}${path.sep}`)) throw new Error(`npm package escapes node_modules: ${key}`);
    const installed = readJson(path.join(real, 'package.json'));
    if (installed.version !== locked.version) throw new Error(`Installed/locked npm version mismatch: ${key}`);
    if (locked.dev) throw new Error(`Production traversal reached a dev-only npm lock entry: ${key}`);
    selected.add(key);
    const license = licenseExpression(installed.license) ?? licenseExpression(locked.license);
    if (installed.license && locked.license && licenseExpression(installed.license) !== licenseExpression(locked.license)) issue('NPM_LICENSE_METADATA_MISMATCH', `npm:${installed.name}@${installed.version}`, 'Installed and locked license declarations differ; inspect original terms.');
    collectPackage({ ecosystem: 'npm', name: installed.name, version: installed.version, identity: key,
      root: real, source: locked.resolved ?? key, repository: typeof installed.repository === 'object' ? installed.repository.url : installed.repository,
      authors: [...declaredPeople(installed.author), ...declaredPeople(installed.contributors)], license,
      licenseFile: /^SEE LICEN[CS]E IN (.+)$/i.exec(license ?? '')?.[1],
      relationship: 'production dependency graph (dependencies/optionalDependencies and installed peers); npm devDependencies excluded' });
    for (const name of Object.keys(locked.dependencies ?? {}).sort(cmp)) visit(resolve(key, name));
    for (const name of Object.keys(locked.optionalDependencies ?? {}).sort(cmp)) visit(resolve(key, name, true));
    for (const name of Object.keys(locked.peerDependencies ?? {}).sort(cmp)) visit(resolve(key, name, Boolean(locked.peerDependenciesMeta?.[name]?.optional)));
  }
  for (const name of Object.keys(pkg.dependencies ?? {}).sort(cmp)) visit(resolve('', name));
  for (const name of Object.keys(pkg.optionalDependencies ?? {}).sort(cmp)) visit(resolve('', name, true));
}

function cargoPackages() {
  let metadata;
  try {
    metadata = JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--offline', '--format-version=1', '--filter-platform', target,
      '--manifest-path', path.join(ROOT, 'src-tauri', 'Cargo.toml')], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 120000, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'], shell: false,
    }));
  } catch (e) {
    throw new Error(`Offline locked cargo metadata failed. No installation, network retry, or build was attempted.\n${String(e.stderr ?? e.message).slice(0, 6000)}`);
  }
  if (!metadata.resolve?.root) throw new Error('Expected a Cargo application root and resolved dependency graph.');
  const packages = new Map(metadata.packages.map(p => [p.id, p]));
  const nodes = new Map(metadata.resolve.nodes.map(n => [n.id, n]));
  const workspace = new Set(metadata.workspace_members);
  const reach = new Map();
  const queue = [[metadata.resolve.root, false]];
  while (queue.length) {
    const [id, build] = queue.pop();
    const bit = build ? 2 : 1;
    if ((reach.get(id) ?? 0) & bit) continue;
    reach.set(id, (reach.get(id) ?? 0) | bit);
    const node = nodes.get(id);
    if (!node) throw new Error(`Missing Cargo resolve node: ${id}`);
    for (const dep of node.deps) {
      const child = packages.get(dep.pkg);
      if (!child) throw new Error(`Missing Cargo package metadata: ${dep.pkg}`);
      const procMacro = child.targets.some(t => t.kind.includes('proc-macro'));
      for (const kind of dep.dep_kinds) {
        if (kind.kind === 'dev') continue;
        if (![null, 'normal', 'build'].includes(kind.kind)) throw new Error(`Unexpected Cargo dependency kind: ${kind.kind}`);
        queue.push([dep.pkg, build || kind.kind === 'build' || procMacro]);
      }
    }
  }
  for (const p of [...packages.values()].filter(p => reach.has(p.id) && !workspace.has(p.id))
    .sort((a, b) => cmp(a.name, b.name) || cmp(a.version, b.version) || cmp(a.id, b.id))) {
    if (!p.source?.startsWith('registry+')) issue('NONREGISTRY_SOURCE_REVIEW', `cargo:${p.name}@${p.version}`, 'Dependency is not a registry package; confirm source provenance and exact revision.');
    const role = reach.get(p.id);
    collectPackage({ ecosystem: 'cargo', name: p.name, version: p.version, identity: p.id,
      root: path.dirname(p.manifest_path), source: p.source ?? p.id, repository: p.repository,
      authors: p.authors, license: p.license ?? null, licenseFile: p.license_file,
      relationship: `${role === 1 ? 'normal dependency path' : role === 2 ? 'build/proc-macro path only' : 'normal AND build/proc-macro paths'}; conservative Windows metadata closure, NOT a proven runtime inventory` });
  }
}

function generateSourceGuide() {
  const covered = inventory.filter(p => /\bMPL-2\.0\b/.test(p.declaredLicense ?? ''));
  if (!covered.length) return;
  const lines = [MARKER, '', '# Covered third-party source availability', '',
    'The third-party packages listed below declare Mozilla Public License 2.0 (MPL-2.0). The covered third-party source remains available under MPL-2.0. QGitGraph-owned application code is licensed under MIT (see the root LICENSE); that does not relicense these dependencies or assign MPL to unrelated application files.', '',
    '## How recipients can obtain source', '',
    '- Exact original source archives are supplied in the adjacent `sources/` directory. They are ordinary `.crate` gzip-compressed tar archives and can be opened with archive tools that support `.tar.gz` (or extracted with `tar -xzf <name-version.crate>`). Their original source notices are retained unchanged.',
    '- Identical public downloads are linked below. The archive SHA-256 values are verified against Cargo.lock. These mirrors are additional access routes; retain and deliver the included archives so source access does not depend only on an external website.',
    '- No modification of these dependency sources is performed by this generator. If a release patches or changes covered files, the distributor must replace/supplement these archives with the actual preferred form for modification and keep this notice accurate. Check final release sources before distribution.',
    '- License copies and original source attribution comments are linked in the package notices. Recipients may use and modify the covered source according to MPL-2.0. Nothing in application terms may limit those source rights.', '',
    '| Package | Included source archive | SHA-256 | Public original | Original terms and attribution |', '| --- | --- | --- | --- | --- |',
    ...covered.map(p => `| ${md(p.name)} ${md(p.version)} | ${p.sourceArchive ? `[${path.posix.basename(p.sourceArchive.output)}](sources/${path.posix.basename(p.sourceArchive.output)})` : '**UNKNOWN / not included**'} | ${p.sourceArchive ? `\`${p.sourceArchive.sha256}\`` : 'UNKNOWN'} | ${p.sourceArchive?.sourceURL ?? 'UNKNOWN'} | [Package notice](${path.posix.relative('notices', p.notice)}) |`), '',
    '## Distributor review', '',
    'Keep this guide and the included source archives accessible to recipients together with the third-party notice index. Confirm exact covered versions, actual modifications, release packaging and timely source availability. Build-only crates are retained conservatively; inclusion here is not a claim that their code is in the executable. This source-access package is a compliance aid, not a legal opinion or warranty.', '',
  ];
  add('notices/source-availability.md', lines.join('\n'));
}

function generateIndex(hashes) {
  const unknown = issues.filter(i => i.code.startsWith('UNKNOWN') || i.code.startsWith('MISSING') || i.code.startsWith('UNSCANNED'));
  const npm = inventory.filter(p => p.ecosystem === 'npm');
  const cargo = inventory.filter(p => p.ecosystem === 'cargo');
  const lines = [MARKER, '', '# Third-party notices — QGitGraph', '',
    'QGitGraph is an independent product. It does not reuse the restricted upstream GitGraph implementation or assets and is not affiliated with, sponsored by, or endorsed by that upstream project. No upstream GitGraph license is used as this application\'s license.', '',
    '**Application license:** QGitGraph-owned source code is licensed under the MIT License; see [LICENSE](LICENSE). Third-party components are not relicensed by that choice: their original copyrights, license alternatives, notices and covered-source rights remain with their respective holders.', '',
    '## Collection scope and limits', '',
    `- Target: \`${target}\`; default Cargo manifest features as reported by offline locked metadata.`,
    `- npm: **${npm.length}** installed, locked production packages; starts at package.json dependencies/optionalDependencies, follows transitive and installed peer dependencies. npm dev tools (Vite, TypeScript, Vitest, Tauri CLI, etc.) are intentionally outside this collection. Bundled helpers inside production packages are inspected separately.`,
    `- Cargo: **${cargo.length}** third-party packages reachable through non-dev edges in \`cargo metadata --locked --offline --format-version=1 --filter-platform ${target}\`. Includes build dependencies, proc macros, their transitive dependencies, and feature-unified metadata. Root/workspace application code is not assigned a license here.`,
    '- **Conservatively over-inclusive:** normal/build-path labels are graph reachability, not evidence that a crate is linked or distributed. Metadata filtering/feature unification can retain packages/features that the final artifact does not use; no compilation or binary reachability analysis was performed. Dev-only paths are not traversed. This is NOT an exact runtime bill of materials.',
    '- Original LICENSE/LICENCE/COPYING/NOTICE/COPYRIGHT/AUTHORS/UNLICENSE/PATENTS files, including nested legal files, are copied byte-for-byte. Original source copyright/license comments are retained separately. Metadata author names are labelled as authors, never invented as copyright holders.',
    '- No license language is synthesized or guessed from SPDX. For six exact pinned crates that omit standalone text, verified official upstream or explicitly referenced Mozilla license-steward text is supplied with source URL, packaged revision and SHA-256. Original Microsoft SDK LICENSE/NOTICE is separately retained after matching the static loader bytes. All future unmatched gaps remain UNKNOWN. Keeping license alternatives does not choose a license for the application.',
    '- No installs, network access, package lifecycle scripts, Cargo build, or package code execution are used. Only Node built-ins and offline Cargo metadata are required.', '',
    '## Redistribution status — review required', '',
    `**NOT release clearance. ${unknown.length} missing/unknown/unscanned-text finding(s); ${issues.length} total package review finding(s).** File collection is not legal advice or a warranty of compliance. All obligations must be checked against the actual Windows artifact and the original terms.`, '',
    '- Ship this index **together with the entire referenced notices tree** in an accessible location in the distributed application/installer. Generation alone does not embed these files; installer/resource configuration was not changed by this script.',
    '- Resolve every missing-license item below from the exact upstream release/revision, preserving original copyright statements and terms. Do not substitute another crate\'s license merely because its SPDX identifier matches.',
    '- MPL-2.0 covered dependencies: exact Cargo.lock-checksummed source archives and recipient-facing access instructions are supplied in [notices/source-availability.md](notices/source-availability.md) and [notices/sources/](notices/sources/). Deliver these along with this index; review actual covered-source modifications and recipient accessibility. This does not assign MPL to unrelated application source and is not a legal clearance.',
    '- Microsoft WebView2Loader SDK 1.0.3800.47: original NuGet LICENSE.txt and NOTICE.txt are linked from the webview2-com-sys package notice, with source-package hash and byte-for-byte native loader match. Separately installed WebView2 runtime/bootstrapper, MSVC/Windows runtimes, installer/NSIS components/plugins and other native redistributables still need review against the final artifact; Rust/npm SPDX declarations alone do not cover them.',
    '- Git is expected to be an independently installed system prerequisite, not bundled. If Git or another executable/runtime is later bundled, separately collect its notices/source obligations. This collection does not grant rights to redistribute it.',
    '- No restricted upstream GitGraph code, art, notices, or license is imported as an application asset/license by this generator. Independence is a scope statement, not a substitute for provenance review.', '',
    '## Findings', '',
    '| Finding | Package | Required review |', '| --- | --- | --- |',
    ...(issues.length ? issues.map(i => `| ${md(i.code)} | ${md(i.package)} | ${md(i.message)} |`) : ['| None automatically flagged | — | Still review the actual artifact and all terms. |']), '',
    '## Package index', '',
    '| Ecosystem | Package | Locked version | Declared license (uninterpreted) | Relationship | Collection | Original text and attribution |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...inventory.map(p => `| ${p.ecosystem} | ${md(p.name)} | ${md(p.version)} | ${md(p.declaredLicense)} | ${md(p.relationship)} | ${p.collectionStatus} | [Files and package notice](${p.notice}) |`), '',
    '## Reproduction and integrity', '',
    'Run from the project (or invoke the script by absolute path):', '',
    '```text', 'node scripts/generate-notices.mjs', 'node scripts/generate-notices.mjs --check', '```', '',
    '`--check` means the generated bytes match the installed locked sources, NOT that legal review passed. The script refuses unowned output directories, edited/unrecognized generated files, symlinks, and hardlinked output files. Only previously owned, hash-verified stale files may be removed; no recursive deletion is used.', '',
    'Machine-readable inventory, source revisions, file hashes and ownership map: [notices/manifest.json](notices/manifest.json). There is no generation timestamp or local registry/user path in the inventory; identical inputs yield identical bytes.', '',
    '| Input | SHA-256 |', '| --- | --- |', ...Object.entries(hashes).map(([file, hash]) => `| ${file} | \`${hash}\` |`), '',
  ];
  add(INDEX, lines.join('\n'));
}

function writeOutputs(previous, hashes) {
  assertInputs(hashes);
  // Recheck after scanning: do not overwrite concurrently modified outputs.
  const now = inspectOwnedOutput();
  if (json(now) !== json(previous)) throw new Error('Notices changed during collection; refusing to overwrite.');
  const ownedFiles = Object.fromEntries([...outputs].sort(([a], [b]) => cmp(a, b)).map(([file, bytes]) => [file, sha(bytes)]));
  add(MANIFEST, json({ schemaVersion: SCHEMA, generator: GENERATOR, target,
    scope: 'npm production graph + conservative non-dev Windows Cargo metadata closure including build/proc-macro dependencies; not exact runtime',
    legalClearance: false, inputs: hashes, counts: { npm: inventory.filter(p => p.ecosystem === 'npm').length, cargo: inventory.filter(p => p.ecosystem === 'cargo').length },
    findings: issues, packages: inventory, ownedFiles }));
  const stale = Object.keys(previous?.ownedFiles ?? {}).filter(file => !outputs.has(file));
  if (check) {
    const different = [...outputs].filter(([file, bytes]) => !lstat(destination(file)) || !fs.readFileSync(destination(file)).equals(bytes)).map(([file]) => file);
    if (stale.length || different.length) throw new Error(`Generated notices are not current (${different.length} missing/different, ${stale.length} stale). Run without --check.`);
    console.log(`Verified ${outputs.size} generated files; bytes match locked local dependencies.`);
    return;
  }
  let changed = 0;
  for (const [file, bytes] of outputs) {
    if (file === MANIFEST) continue;
    noLinkedParents(file);
    const dest = destination(file);
    const existing = lstat(dest);
    if (existing) { regularFile(dest); if (fs.readFileSync(dest).equals(bytes)) continue; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, bytes, { flag: existing ? 'w' : 'wx' });
    changed++;
  }
  // "Look before deleting": ownership, all file hashes, and directory contents
  // were verified twice above. Only exact old owned files are eligible.
  if (stale.length) console.log(`Removing ${stale.length} obsolete, ownership/hash-verified generated files.`);
  for (const file of stale) {
    noLinkedParents(file);
    regularFile(destination(file));
    if (sha(fs.readFileSync(destination(file))) !== previous.ownedFiles[file]) throw new Error(`Stale output changed: ${file}`);
    fs.unlinkSync(destination(file));
  }
  const newDirs = dirsOf(outputs.keys());
  for (const dir of [...dirsOf(Object.keys(previous?.ownedFiles ?? {}))].sort((a, b) => b.length - a.length)) {
    if (newDirs.has(dir) || dir === 'notices') continue;
    const stat = lstat(destination(`${dir}/.directory-check`));
    if (stat) throw new Error(`Unexpected directory guard file: ${dir}`);
    const full = path.join(ROOT, ...dir.split('/'));
    const dirStat = lstat(full);
    if (!dirStat) continue;
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || fs.readdirSync(full).length) throw new Error(`Refusing nonempty/linked stale directory: ${dir}`);
    fs.rmdirSync(full);
  }
  const manifestDest = destination(MANIFEST);
  if (lstat(manifestDest)) regularFile(manifestDest);
  if (!lstat(manifestDest) || !fs.readFileSync(manifestDest).equals(outputs.get(MANIFEST))) {
    fs.writeFileSync(manifestDest, outputs.get(MANIFEST), { flag: previous ? 'w' : 'wx' });
    changed++;
  }
  console.log(`Generated ${inventory.length} package notices and ${outputs.size} files (${changed} changed; ${stale.length} stale owned files removed).`);
}

try {
  const previous = inspectOwnedOutput();
  const hashes = inputHashes();
  npmPackages();
  cargoPackages();
  inventory.sort((a, b) => cmp(a.ecosystem, b.ecosystem) || cmp(a.name, b.name) || cmp(a.version, b.version) || cmp(a.identity, b.identity));
  issues.sort((a, b) => cmp(a.code, b.code) || cmp(a.package, b.package) || cmp(a.message, b.message));
  generateSourceGuide();
  generateIndex(hashes);
  writeOutputs(previous, hashes);
  const missing = issues.filter(i => /^(UNKNOWN|MISSING|UNSCANNED)/.test(i.code));
  console.log(`Target ${target}; npm ${inventory.filter(p => p.ecosystem === 'npm').length}; Cargo ${inventory.filter(p => p.ecosystem === 'cargo').length} (conservative build+normal closure).`);
  console.log(`Review required: ${missing.length} missing/unknown/unscanned-text finding(s), ${issues.length} total package finding(s). NOT legal clearance. See ${path.join(ROOT, INDEX)}.`);
} catch (e) {
  console.error(`Notice generation refused/failed: ${e.message}`);
  process.exitCode = 1;
}
