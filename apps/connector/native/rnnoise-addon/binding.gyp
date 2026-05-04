{
  "targets": [
    {
      "target_name": "rnnoise",
      "sources": [
        "src/addon.c",
        "vendor/rnnoise/src/denoise.c",
        "vendor/rnnoise/src/rnn.c",
        "vendor/rnnoise/src/rnn_data.c",
        "vendor/rnnoise/src/pitch.c",
        "vendor/rnnoise/src/kiss_fft.c",
        "vendor/rnnoise/src/celt_lpc.c"
      ],
      "include_dirs": [
        "vendor/rnnoise/include",
        "vendor/rnnoise/src"
      ],
      "defines": [
        "RNNOISE_BUILD=1",
        "_USE_MATH_DEFINES",
        "_GNU_SOURCE"
      ],
      "cflags": [
        "-std=c11",
        "-O3"
      ],
      "conditions": [
        [
          "OS==\"mac\"",
          {
            "xcode_settings": {
              "OTHER_CFLAGS": [
                "-std=c11",
                "-O3"
              ]
            }
          }
        ]
      ]
    }
  ]
}

