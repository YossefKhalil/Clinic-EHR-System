# Build the M0 wllama WASM runtime without Docker.
#
# The stock @wllama/wllama package is built with Emscripten's default
# CMAKE_SYSTEM_PROCESSOR=x86. llama.cpp then takes its generic CPU fallback and
# the Q4_0 dot product is scalar. This script passes
# -DEMSCRIPTEN_SYSTEM_PROCESSOR=wasm so arch/wasm/quants.c is compiled.
#
# Usage:
#   ./build-wllama-wasm.ps1
#   ./build-wllama-wasm.ps1 -RelaxedSimd
#
# Prerequisites:
#   - Emscripten 4.0.20 activated (see $EmsdkDir)
#   - CMake and Ninja (the VS Build Tools copies are found automatically)

param(
  [string]$EmsdkDir = $(if ($env:EMSDK_DIR) { $env:EMSDK_DIR } else { 'E:\GY-Labs\dev-tools\emsdk' }),
  [string]$WllamaDir = $(if ($env:WLLAMA_DIR) { $env:WLLAMA_DIR } else { 'E:\GY-Labs\dev-tools\wllama-custom' }),
  [string]$OutDir = (Join-Path $PSScriptRoot 'custom'),
  [switch]$RelaxedSimd,
  [switch]$Wasm32Jspi
)

$ErrorActionPreference = 'Stop'

$cmakeCandidates = @(
  'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe',
  'C:\Program Files\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
)
$ninjaCandidates = @(
  'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe',
  'C:\Program Files\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe'
)

$cmake = $cmakeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
$ninja = $ninjaCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
$toolchain = Join-Path $EmsdkDir 'upstream\emscripten\cmake\Modules\Platform\Emscripten.cmake'

if (-not $cmake) { throw 'CMake not found. Install CMake or set the VS Build Tools path.' }
if (-not $ninja) { throw 'Ninja not found. Install Ninja or set the VS Build Tools path.' }
if (-not (Test-Path $toolchain)) { throw "Emscripten toolchain not found: $toolchain" }
if (-not (Test-Path (Join-Path $WllamaDir 'llama.cpp'))) { throw "wllama source with llama.cpp submodule not found: $WllamaDir" }

$env:EMSDK = $EmsdkDir
$env:EMSDK_NODE = Join-Path $EmsdkDir 'node\24.19.0_64bit\node.exe'
$env:EMSDK_PYTHON = Join-Path $EmsdkDir 'python\3.13.3_64bit\python.exe'
$env:PATH = "$EmsdkDir;$EmsdkDir\upstream\emscripten;$env:PATH"

$buildDir = Join-Path $WllamaDir 'build-wasm32'
if (Test-Path $buildDir) { Remove-Item -Recurse -Force $buildDir }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$cmakeArgs = @(
  '-S', $WllamaDir,
  '-B', $buildDir,
  '-G', 'Ninja',
  "-DCMAKE_MAKE_PROGRAM=$ninja",
  "-DCMAKE_TOOLCHAIN_FILE=$toolchain",
  '-DCMAKE_BUILD_TYPE=Release',
  '-DEMSCRIPTEN_SYSTEM_PROCESSOR=wasm',
  '-DGGML_WEBGPU=OFF',
  '-DGGML_NATIVE=OFF',
  '-DLLAMA_CURL=OFF',
  '-DWLLAMA_TEST_BACKEND=OFF'
)

if ($Wasm32Jspi) {
  # wasm32 without Asyncify: the wasm uses JSPI. The JS worker still receives
  # compat=true so it uses 32-bit Number pointers and async file reads.
  $cmakeArgs += '-DWLLAMA_COMPAT=OFF'
  $cmakeArgs += '-DLLAMA_WASM_MEM64=OFF'
} else {
  $cmakeArgs += '-DWLLAMA_COMPAT=ON'
  $cmakeArgs += '-DLLAMA_WASM_MEM64=OFF'
}

if ($RelaxedSimd) {
  $cmakeArgs += '-DCMAKE_C_FLAGS=-mrelaxed-simd'
  $cmakeArgs += '-DCMAKE_CXX_FLAGS=-mrelaxed-simd'
}

Write-Host "Configuring wllama at $WllamaDir"
Write-Host "CMAKE_SYSTEM_PROCESSOR override: wasm"
& $cmake @cmakeArgs
if ($LASTEXITCODE -ne 0) { throw "CMake configure failed with exit code $LASTEXITCODE" }

Write-Host 'Building wllama...'
& $cmake --build $buildDir --target wllama --parallel
if ($LASTEXITCODE -ne 0) { throw "CMake build failed with exit code $LASTEXITCODE" }

$wasm = Join-Path $buildDir 'wllama.wasm'
$js = Join-Path $buildDir 'wllama.js'
if (-not (Test-Path $wasm) -or -not (Test-Path $js)) {
  throw "Build output is missing: $wasm or $js"
}

Copy-Item $wasm (Join-Path $OutDir 'wllama.wasm') -Force
Copy-Item $js (Join-Path $OutDir 'wllama.js') -Force

Write-Host "Copied to $OutDir"
Get-ChildItem $OutDir | Select-Object Name, Length | Format-Table -AutoSize