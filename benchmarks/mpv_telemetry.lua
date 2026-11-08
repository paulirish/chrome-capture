-- Copyright 2026 Google LLC
-- SPDX-License-Identifier: Apache-2.0
--
-- mpv Lua telemetry observer for measuring playback decode cost, VO/decoder
-- frame drops, display-resample vsync jitter, and untimed decode FPS.
--
-- Usage:
--   MPV_TELEMETRY_OUT=/tmp/mpv.json mpv --no-config --no-audio --keep-open=no \
--     --script=benchmarks/mpv_telemetry.lua --vo=gpu-next --hwdec=auto-safe \
--     --video-sync=display-resample recording.mp4
--
--   # Untimed max-throughput decode benchmark:
--   MPV_TELEMETRY_OUT=/tmp/mpv.json mpv --no-config --no-audio --keep-open=no \
--     --script=benchmarks/mpv_telemetry.lua --vo=null --hwdec=no --untimed recording.mp4

local utils = require 'mp.utils'

local stats = {
  path = nil,
  video_codec = nil,
  hwdec_current = nil,
  video_params = nil,
  display_fps = nil,
  container_fps = nil,
  samples = {},
  max_vsync_jitter = 0,
  sum_vsync_jitter = 0,
  jitter_samples = 0,
  start_wall = nil,
}

mp.register_event('file-loaded', function()
  stats.path = mp.get_property('path')
  stats.video_codec = mp.get_property('video-codec')
  stats.hwdec_current = mp.get_property('hwdec-current')
  stats.video_params = mp.get_property_native('video-params')
  stats.display_fps = mp.get_property_number('display-fps')
  stats.container_fps = mp.get_property_number('container-fps')
  stats.start_wall = mp.get_time()
end)

local timer = mp.add_periodic_timer(0.05, function()
  local hw = mp.get_property('hwdec-current')
  if hw and hw ~= '' then stats.hwdec_current = hw end
  local dfps = mp.get_property_number('display-fps')
  if dfps then stats.display_fps = dfps end

  local jitter = mp.get_property_number('vsync-jitter')
  if jitter then
    stats.jitter_samples = stats.jitter_samples + 1
    stats.sum_vsync_jitter = stats.sum_vsync_jitter + jitter
    if jitter > stats.max_vsync_jitter then
      stats.max_vsync_jitter = jitter
    end
  end

  table.insert(stats.samples, {
    t = mp.get_property_number('time-pos'),
    vf_fps = mp.get_property_number('estimated-vf-fps'),
    disp_fps = mp.get_property_number('estimated-display-fps'),
    vo_drops = mp.get_property_number('frame-drop-count'),
    dec_drops = mp.get_property_number('decoder-frame-drop-count'),
    mistimed = mp.get_property_number('mistimed-frame-count'),
    delayed = mp.get_property_number('vo-delayed-frame-count'),
    jitter = jitter,
    bitrate = mp.get_property_number('video-bitrate'),
  })
end)

mp.register_event('end-file', function(ev)
  timer:kill()
  local elapsed = stats.start_wall and (mp.get_time() - stats.start_wall) or 0
  local last = {}
  local max_drops, max_dec_drops, max_mistimed, max_delayed = 0, 0, 0, 0
  local vf_fps_sum, vf_fps_n = 0, 0
  local disp_fps_sum, disp_fps_n = 0, 0
  local bitrate_sum, bitrate_n = 0, 0

  -- Sample before EOF teardown because mpv clears VO/decoder counters on end-file.
  for _, s in ipairs(stats.samples) do
    if s.vo_drops and s.vo_drops > max_drops then max_drops = s.vo_drops end
    if s.dec_drops and s.dec_drops > max_dec_drops then max_dec_drops = s.dec_drops end
    if s.mistimed and s.mistimed > max_mistimed then max_mistimed = s.mistimed end
    if s.delayed and s.delayed > max_delayed then max_delayed = s.delayed end
    if s.vf_fps and s.vf_fps > 0 then
      vf_fps_sum = vf_fps_sum + s.vf_fps
      vf_fps_n = vf_fps_n + 1
      last.vf_fps = s.vf_fps
    end
    if s.disp_fps and s.disp_fps > 0 then
      disp_fps_sum = disp_fps_sum + s.disp_fps
      disp_fps_n = disp_fps_n + 1
      last.disp_fps = s.disp_fps
    end
    if s.bitrate and s.bitrate > 0 then
      bitrate_sum = bitrate_sum + s.bitrate
      bitrate_n = bitrate_n + 1
    end
  end

  local summary = {
    path = stats.path,
    reason = ev.reason,
    wall_elapsed_s = tonumber(string.format('%.4f', elapsed)),
    video_codec = stats.video_codec,
    hwdec_current = stats.hwdec_current,
    width = stats.video_params and stats.video_params.w,
    height = stats.video_params and stats.video_params.h,
    pixelformat = stats.video_params and stats.video_params.pixelformat,
    hw_pixelformat = stats.video_params and stats.video_params['hw-pixelformat'],
    colormatrix = stats.video_params and stats.video_params.colormatrix,
    colorlevels = stats.video_params and stats.video_params.colorlevels,
    container_fps = stats.container_fps,
    display_fps = stats.display_fps,
    estimated_vf_fps = vf_fps_n > 0 and tonumber(string.format('%.2f', vf_fps_sum / vf_fps_n)) or nil,
    last_vf_fps = last.vf_fps,
    estimated_display_fps = disp_fps_n > 0 and tonumber(string.format('%.2f', disp_fps_sum / disp_fps_n)) or nil,
    frame_drop_count = max_drops,
    decoder_frame_drop_count = max_dec_drops,
    mistimed_frame_count = max_mistimed,
    vo_delayed_frame_count = max_delayed,
    avg_vsync_jitter = stats.jitter_samples > 0 and (stats.sum_vsync_jitter / stats.jitter_samples) or nil,
    max_vsync_jitter = stats.jitter_samples > 0 and stats.max_vsync_jitter or nil,
    avg_bitrate_kbps = bitrate_n > 0 and tonumber(string.format('%.1f', bitrate_sum / bitrate_n / 1000)) or nil,
    sample_count = #stats.samples,
  }

  local out_file = os.getenv('MPV_TELEMETRY_OUT')
  if out_file and out_file ~= '' then
    local f = io.open(out_file, 'w')
    if f then
      f:write(utils.format_json(summary))
      f:close()
    end
  end
  mp.msg.info('MPV_TELEMETRY_JSON:' .. utils.format_json(summary))
end)
