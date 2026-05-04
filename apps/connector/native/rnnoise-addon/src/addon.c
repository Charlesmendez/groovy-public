#include <math.h>
#include <node_api.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "rnnoise.h"

static void throw_error(napi_env env, const char *msg) {
  napi_throw_error(env, NULL, msg);
}

static inline float int16_to_float(int16_t s) {
  return (float)s / 32768.0f;
}

static inline int16_t float_to_int16(float x) {
  if (x > 0.9999695f) x = 0.9999695f;
  if (x < -1.0f) x = -1.0f;
  int v = (int)lrintf(x * 32768.0f);
  if (v > 32767) v = 32767;
  if (v < -32768) v = -32768;
  return (int16_t)v;
}

typedef struct {
  DenoiseState *st;
  int frame_size;
} RnnoiseHandle;

static void handle_finalize(napi_env env, void *finalize_data, void *finalize_hint) {
  (void)env;
  (void)finalize_hint;
  RnnoiseHandle *h = (RnnoiseHandle *)finalize_data;
  if (!h) return;
  if (h->st) {
    rnnoise_destroy(h->st);
    h->st = NULL;
  }
  free(h);
}

static napi_status get_handle(napi_env env, napi_value value, RnnoiseHandle **out) {
  RnnoiseHandle *h = NULL;
  napi_status st = napi_get_value_external(env, value, (void **)&h);
  if (st != napi_ok || !h || !h->st) {
    throw_error(env, "rnnoise: invalid state handle");
    return napi_invalid_arg;
  }
  *out = h;
  return napi_ok;
}

static napi_status get_input_buffer(napi_env env, napi_value value, uint8_t **data, size_t *len) {
  bool is_buf = false;
  napi_status st = napi_is_buffer(env, value, &is_buf);
  if (st != napi_ok || !is_buf) {
    throw_error(env, "rnnoise: input must be a Buffer");
    return napi_invalid_arg;
  }

  st = napi_get_buffer_info(env, value, (void **)data, len);
  if (st != napi_ok) {
    throw_error(env, "rnnoise: failed to read input Buffer");
    return st;
  }

  if ((*len % 2) != 0) {
    throw_error(env, "rnnoise: input Buffer length must be even (PCM16LE)");
    return napi_invalid_arg;
  }

  return napi_ok;
}

static napi_status process_frames(
    RnnoiseHandle *h,
    const uint8_t *data,
    size_t len,
    uint8_t *out_data,
    double *avg_vad,
    double *max_vad) {
  const size_t frame_bytes = (size_t)h->frame_size * 2;
  const size_t frames = len / frame_bytes;
  const int16_t *in16 = (const int16_t *)data;
  int16_t *out16 = (int16_t *)out_data;
  float *in_f = (float *)malloc(sizeof(float) * (size_t)h->frame_size);
  float *out_f = (float *)malloc(sizeof(float) * (size_t)h->frame_size);
  double vad_sum = 0.0;
  double vad_peak = 0.0;
  size_t vad_count = 0;

  if (!in_f || !out_f) {
    free(in_f);
    free(out_f);
    return napi_generic_failure;
  }

  for (size_t f = 0; f < frames; f++) {
    const int16_t *frame_in = in16 + f * (size_t)h->frame_size;
    int16_t *frame_out = out16 + f * (size_t)h->frame_size;
    for (int i = 0; i < h->frame_size; i++) {
      in_f[i] = int16_to_float(frame_in[i]);
    }
    float vad = rnnoise_process_frame(h->st, out_f, in_f);
    for (int i = 0; i < h->frame_size; i++) {
      frame_out[i] = float_to_int16(out_f[i]);
    }
    if (isfinite(vad)) {
      vad_sum += (double)vad;
      if (vad > vad_peak) {
        vad_peak = vad;
      }
      vad_count += 1;
    }
  }

  free(in_f);
  free(out_f);

  if (avg_vad) {
    *avg_vad = vad_count > 0 ? vad_sum / (double)vad_count : 0.0;
  }
  if (max_vad) {
    *max_vad = vad_peak;
  }
  return napi_ok;
}

static napi_value create_state(napi_env env, napi_callback_info info) {
  (void)info;
  RnnoiseHandle *h = (RnnoiseHandle *)calloc(1, sizeof(RnnoiseHandle));
  if (!h) {
    throw_error(env, "rnnoise: allocation failed");
    return NULL;
  }
  h->st = rnnoise_create(NULL);
  if (!h->st) {
    free(h);
    throw_error(env, "rnnoise: rnnoise_create failed");
    return NULL;
  }
  h->frame_size = rnnoise_get_frame_size();

  napi_value ext;
  napi_status st = napi_create_external(env, (void *)h, handle_finalize, NULL, &ext);
  if (st != napi_ok) {
    rnnoise_destroy(h->st);
    h->st = NULL;
    free(h);
    throw_error(env, "rnnoise: napi_create_external failed");
    return NULL;
  }
  return ext;
}

static napi_value destroy_state(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_status st = napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (st != napi_ok || argc < 1) {
    throw_error(env, "rnnoise.destroyState(state) requires 1 arg");
    return NULL;
  }

  RnnoiseHandle *h = NULL;
  st = napi_get_value_external(env, argv[0], (void **)&h);
  if (st != napi_ok || !h) {
    throw_error(env, "rnnoise: invalid state handle");
    return NULL;
  }

  if (h->st) {
    rnnoise_destroy(h->st);
    h->st = NULL;
  }

  napi_value out;
  napi_get_undefined(env, &out);
  return out;
}

static napi_value process_pcm16le(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_status st = napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (st != napi_ok || argc < 2) {
    throw_error(env, "rnnoise.processPcm16le(state, buffer) requires 2 args");
    return NULL;
  }

  RnnoiseHandle *h = NULL;
  if (get_handle(env, argv[0], &h) != napi_ok) {
    return NULL;
  }

  uint8_t *data = NULL;
  size_t len = 0;
  if (get_input_buffer(env, argv[1], &data, &len) != napi_ok) {
    return NULL;
  }

  const size_t frame_bytes = (size_t)h->frame_size * 2;
  const size_t frames = len / frame_bytes;
  const size_t out_len = frames * frame_bytes;
  napi_value out_buf;
  uint8_t *out_data = NULL;
  st = napi_create_buffer(env, out_len, (void **)&out_data, &out_buf);
  if (st != napi_ok) {
    throw_error(env, "rnnoise: failed to allocate output Buffer");
    return NULL;
  }

  if (out_len == 0) {
    return out_buf;
  }

  st = process_frames(h, data, out_len, out_data, NULL, NULL);
  if (st != napi_ok) {
    throw_error(env, "rnnoise: float buffer allocation failed");
    return NULL;
  }

  return out_buf;
}

static napi_value process_pcm16le_with_vad(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_status st = napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (st != napi_ok || argc < 2) {
    throw_error(env, "rnnoise.processPcm16leWithVad(state, buffer) requires 2 args");
    return NULL;
  }

  RnnoiseHandle *h = NULL;
  if (get_handle(env, argv[0], &h) != napi_ok) {
    return NULL;
  }

  uint8_t *data = NULL;
  size_t len = 0;
  if (get_input_buffer(env, argv[1], &data, &len) != napi_ok) {
    return NULL;
  }

  const size_t frame_bytes = (size_t)h->frame_size * 2;
  const size_t frames = len / frame_bytes;
  const size_t out_len = frames * frame_bytes;
  napi_value out_buf;
  uint8_t *out_data = NULL;
  st = napi_create_buffer(env, out_len, (void **)&out_data, &out_buf);
  if (st != napi_ok) {
    throw_error(env, "rnnoise: failed to allocate output Buffer");
    return NULL;
  }

  double avg_vad = 0.0;
  double peak_vad = 0.0;
  if (out_len > 0) {
    st = process_frames(h, data, out_len, out_data, &avg_vad, &peak_vad);
    if (st != napi_ok) {
      throw_error(env, "rnnoise: float buffer allocation failed");
      return NULL;
    }
  }

  napi_value result;
  napi_value avg_vad_value;
  napi_value peak_vad_value;
  st = napi_create_object(env, &result);
  if (st != napi_ok) {
    throw_error(env, "rnnoise: failed to allocate result object");
    return NULL;
  }
  napi_create_double(env, avg_vad, &avg_vad_value);
  napi_create_double(env, peak_vad, &peak_vad_value);
  napi_set_named_property(env, result, "output", out_buf);
  napi_set_named_property(env, result, "vadProbability", avg_vad_value);
  napi_set_named_property(env, result, "maxVadProbability", peak_vad_value);
  return result;
}

static napi_value get_frame_size(napi_env env, napi_callback_info info) {
  (void)info;
  int fs = rnnoise_get_frame_size();
  napi_value v;
  napi_create_int32(env, fs, &v);
  return v;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_value fn_create;
  napi_value fn_destroy;
  napi_value fn_process;
  napi_value fn_process_vad;
  napi_value fn_fs;
  napi_create_function(env, "createState", NAPI_AUTO_LENGTH, create_state, NULL, &fn_create);
  napi_create_function(env, "destroyState", NAPI_AUTO_LENGTH, destroy_state, NULL, &fn_destroy);
  napi_create_function(env, "processPcm16le", NAPI_AUTO_LENGTH, process_pcm16le, NULL, &fn_process);
  napi_create_function(
      env,
      "processPcm16leWithVad",
      NAPI_AUTO_LENGTH,
      process_pcm16le_with_vad,
      NULL,
      &fn_process_vad);
  napi_create_function(env, "getFrameSize", NAPI_AUTO_LENGTH, get_frame_size, NULL, &fn_fs);

  napi_set_named_property(env, exports, "createState", fn_create);
  napi_set_named_property(env, exports, "destroyState", fn_destroy);
  napi_set_named_property(env, exports, "processPcm16le", fn_process);
  napi_set_named_property(env, exports, "processPcm16leWithVad", fn_process_vad);
  napi_set_named_property(env, exports, "getFrameSize", fn_fs);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)

