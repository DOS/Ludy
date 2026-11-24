// SPDX-License-Identifier: AGPL-3.0-only
// Win32 WASAPI per-app process loopback & visible meeting window enumerator for Ludy Desktop (ADR-0055 slice 3, #4516).
// Zero external dependencies; compiled with MSVC / Windows SDK on windows-latest.
// Modes:
//   --list-windows   Outputs a UTF-8 JSON array of visible top-level windows: [{"hwnd","pid","exe","title"}, ...]
//   --pid <pid>      Streams 48 kHz 16-bit stereo PCM of the target process tree to binary stdout until stdin closes.
//                    Exits with code 42 and stderr "PROCESS_LOOPBACK_UNSUPPORTED:0x..." when Win10 build lacks process loopback.
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#define NTDDI_VERSION 0x0A00000A
#include <windows.h>
#include <objbase.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <propidl.h>
#include <fcntl.h>
#include <io.h>
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

namespace {

std::string toUtf8(const std::wstring& wide) {
  if (wide.empty()) return {};
  int needed = WideCharToMultiByte(CP_UTF8, 0, wide.data(), static_cast<int>(wide.size()), nullptr, 0, nullptr, nullptr);
  if (needed <= 0) return {};
  std::string out(static_cast<size_t>(needed), '\0');
  WideCharToMultiByte(CP_UTF8, 0, wide.data(), static_cast<int>(wide.size()), out.data(), needed, nullptr, nullptr);
  return out;
}

void writeJsonString(const std::string& raw) {
  std::putchar('"');
  for (unsigned char ch : raw) {
    if (ch == '"') std::fputs("\\\"", stdout);
    else if (ch == '\\') std::fputs("\\\\", stdout);
    else if (ch == '\b') std::fputs("\\b", stdout);
    else if (ch == '\f') std::fputs("\\f", stdout);
    else if (ch == '\n') std::fputs("\\n", stdout);
    else if (ch == '\r') std::fputs("\\r", stdout);
    else if (ch == '\t') std::fputs("\\t", stdout);
    else if (ch < 0x20) std::printf("\\u%04x", ch);
    else std::putchar(ch);
  }
  std::putchar('"');
}

struct WindowEntry {
  HWND hwnd;
  DWORD pid;
  std::string exe;
  std::string title;
};

std::wstring queryExeBasename(DWORD pid) {
  HANDLE proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!proc) return {};
  wchar_t pathBuf[MAX_PATH * 4];
  DWORD size = static_cast<DWORD>(sizeof(pathBuf) / sizeof(pathBuf[0]));
  std::wstring base;
  if (QueryFullProcessImageNameW(proc, 0, pathBuf, &size) && size > 0) {
    std::wstring full(pathBuf, size);
    size_t pos = full.find_last_of(L"\\/");
    base = pos == std::wstring::npos ? full : full.substr(pos + 1);
  }
  CloseHandle(proc);
  return base;
}

BOOL CALLBACK collectWindowProc(HWND hwnd, LPARAM lParam) {
  auto* entries = reinterpret_cast<std::vector<WindowEntry>*>(lParam);
  if (!IsWindowVisible(hwnd)) return TRUE;
  int len = GetWindowTextLengthW(hwnd);
  if (len <= 0) return TRUE;
  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);
  if (pid == 0 || pid == GetCurrentProcessId()) return TRUE;

  std::wstring titleW(static_cast<size_t>(len) + 1, L'\0');
  int copied = GetWindowTextW(hwnd, titleW.data(), len + 1);
  if (copied <= 0) return TRUE;
  titleW.resize(static_cast<size_t>(copied));

  std::wstring exeW = queryExeBasename(pid);
  if (exeW.empty()) return TRUE;

  entries->push_back(WindowEntry{hwnd, pid, toUtf8(exeW), toUtf8(titleW)});
  return TRUE;
}

int listWindows() {
  std::vector<WindowEntry> entries;
  EnumWindows(collectWindowProc, reinterpret_cast<LPARAM>(&entries));
  std::putchar('[');
  for (size_t i = 0; i < entries.size(); ++i) {
    if (i > 0) std::putchar(',');
    std::fputs("{\"hwnd\":", stdout);
    writeJsonString(std::to_string(reinterpret_cast<uintptr_t>(entries[i].hwnd)));
    std::printf(",\"pid\":%lu,\"exe\":", static_cast<unsigned long>(entries[i].pid));
    writeJsonString(entries[i].exe);
    std::fputs(",\"title\":", stdout);
    writeJsonString(entries[i].title);
    std::putchar('}');
  }
  std::fputs("]\n", stdout);
  std::fflush(stdout);
  return 0;
}

class ActivationHandler final : public IActivateAudioInterfaceCompletionHandler, public IAgileObject {
 public:
  explicit ActivationHandler(HANDLE readyEvent) : readyEvent_(readyEvent) {}

  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    if (riid == IID_IUnknown || riid == __uuidof(IAgileObject) || riid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
      *ppv = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }

  ULONG STDMETHODCALLTYPE AddRef() override { return refCount_.fetch_add(1, std::memory_order_relaxed) + 1; }

  ULONG STDMETHODCALLTYPE Release() override {
    ULONG count = refCount_.fetch_sub(1, std::memory_order_acq_rel) - 1;
    if (count == 0) delete this;
    return count;
  }

  HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation* op) override {
    HRESULT localHr = E_UNEXPECTED;
    IAudioClient* localClient = nullptr;
    if (op) {
      IUnknown* raw = nullptr;
      HRESULT getHr = op->GetActivateResult(&localHr, &raw);
      if (SUCCEEDED(getHr) && SUCCEEDED(localHr) && raw) {
        localHr = raw->QueryInterface(__uuidof(IAudioClient), reinterpret_cast<void**>(&localClient));
      }
      if (raw) raw->Release();
      if (FAILED(getHr)) localHr = getHr;
    }
    std::lock_guard<std::mutex> lock(mutex_);
    if (client_) client_->Release();
    activateHr_ = localHr;
    client_ = localClient;
    completed_ = true;
    if (readyEvent_) SetEvent(readyEvent_);
    return S_OK;
  }

  bool takeResult(HRESULT& outHr, IAudioClient*& outClient) {
    std::lock_guard<std::mutex> lock(mutex_);
    // Detach before caller closes readyEvent_ (e.g., on timeout) so ActivateCompleted never signals a closed handle.
    readyEvent_ = nullptr;
    if (!completed_) {
      outHr = HRESULT_FROM_WIN32(ERROR_TIMEOUT);
      outClient = nullptr;
      return false;
    }
    outHr = activateHr_;
    outClient = client_;
    client_ = nullptr;
    return true;
  }

 private:
  ~ActivationHandler() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (client_) {
      client_->Release();
      client_ = nullptr;
    }
  }
  std::atomic<ULONG> refCount_{1};
  std::mutex mutex_;
  HANDLE readyEvent_;
  bool completed_{false};
  HRESULT activateHr_{E_FAIL};
  IAudioClient* client_{nullptr};
};

bool isProcessLoopbackUnsupportedHr(HRESULT hr) {
  return hr == E_INVALIDARG || hr == E_NOINTERFACE || hr == E_NOTIMPL ||
         hr == HRESULT_FROM_WIN32(ERROR_NOT_SUPPORTED) || hr == HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND);
}

DWORD WINAPI watchStdinThread(LPVOID arg) {
  HANDLE hWatchStop = static_cast<HANDLE>(arg);
  char buf[16];
  DWORD readBytes = 0;
  HANDLE hIn = GetStdHandle(STD_INPUT_HANDLE);
  while (ReadFile(hIn, buf, sizeof(buf), &readBytes, nullptr) && readBytes > 0) {
    if (WaitForSingleObject(hWatchStop, 0) == WAIT_OBJECT_0) break;
  }
  SetEvent(hWatchStop);
  CloseHandle(hWatchStop);
  return 0;
}

void stopWatchThread(HANDLE hStop, HANDLE hWatch) {
  SetEvent(hStop);
  if (hWatch) {
    CancelSynchronousIo(hWatch);
    WaitForSingleObject(hWatch, 2000);
    CloseHandle(hWatch);
  }
}

int streamProcessLoopback(DWORD targetPid) {
  _setmode(_fileno(stdout), _O_BINARY);
  _setmode(_fileno(stdin), _O_BINARY);

  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) {
    std::fprintf(stderr, "ACTIVATE_FAILED:0x%08lX\n", static_cast<unsigned long>(hr));
    return 2;
  }

  HANDLE hReady = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  HANDLE hStop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!hReady || !hStop) {
    if (hReady) CloseHandle(hReady);
    if (hStop) CloseHandle(hStop);
    CoUninitialize();
    return 2;
  }

  HANDLE hWatchStop = nullptr;
  HANDLE hWatch = nullptr;
  if (DuplicateHandle(GetCurrentProcess(), hStop, GetCurrentProcess(), &hWatchStop, 0, FALSE, DUPLICATE_SAME_ACCESS)) {
    hWatch = CreateThread(nullptr, 0, watchStdinThread, static_cast<LPVOID>(hWatchStop), 0, nullptr);
    if (!hWatch) {
      CloseHandle(hWatchStop);
    }
  }

  auto* handler = new ActivationHandler(hReady);
  AUDIOCLIENT_ACTIVATION_PARAMS params{};
  params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = targetPid;
  params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;

  PROPVARIANT activateParams{};
  activateParams.vt = VT_BLOB;
  activateParams.blob.cbSize = sizeof(params);
  activateParams.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

  IActivateAudioInterfaceAsyncOperation* asyncOp = nullptr;
  IAudioClient* audioClient = nullptr;
  hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &activateParams, handler, &asyncOp);
  if (SUCCEEDED(hr)) {
    WaitForSingleObject(hReady, 5000);
    handler->takeResult(hr, audioClient);
  } else {
    HRESULT ignoredHr = E_FAIL;
    handler->takeResult(ignoredHr, audioClient);
  }
  if (asyncOp) asyncOp->Release();

  if (FAILED(hr) || !audioClient) {
    HRESULT failHr = FAILED(hr) ? hr : E_FAIL;
    std::fprintf(stderr, "%s:0x%08lX\n", isProcessLoopbackUnsupportedHr(failHr) ? "PROCESS_LOOPBACK_UNSUPPORTED" : "ACTIVATE_FAILED", static_cast<unsigned long>(failHr));
    int code = isProcessLoopbackUnsupportedHr(failHr) ? 42 : 2;
    if (audioClient) audioClient->Release();
    handler->Release();
    stopWatchThread(hStop, hWatch);
    CloseHandle(hReady);
    CloseHandle(hStop);
    CoUninitialize();
    return code;
  }

  WAVEFORMATEX wfx{};
  wfx.wFormatTag = WAVE_FORMAT_PCM;
  wfx.nChannels = 2;
  wfx.nSamplesPerSec = 48000;
  wfx.wBitsPerSample = 16;
  wfx.nBlockAlign = static_cast<WORD>((wfx.nChannels * wfx.wBitsPerSample) / 8);
  wfx.nAvgBytesPerSec = wfx.nSamplesPerSec * wfx.nBlockAlign;

  hr = audioClient->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 200000, 0, &wfx, nullptr);
  if (hr == AUDCLNT_E_UNSUPPORTED_FORMAT) {
    hr = audioClient->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        200000,
        0,
        &wfx,
        nullptr);
  }

  IAudioCaptureClient* captureClient = nullptr;
  if (SUCCEEDED(hr)) {
    hr = audioClient->GetService(__uuidof(IAudioCaptureClient), reinterpret_cast<void**>(&captureClient));
  }
  if (SUCCEEDED(hr)) {
    hr = audioClient->Start();
  }

  int exitCode = 0;
  if (FAILED(hr) || !captureClient) {
    std::fprintf(stderr, "%s:0x%08lX\n", isProcessLoopbackUnsupportedHr(hr) ? "PROCESS_LOOPBACK_UNSUPPORTED" : "INIT_FAILED", static_cast<unsigned long>(hr));
    exitCode = isProcessLoopbackUnsupportedHr(hr) ? 42 : 3;
  } else {
    std::fputs("WASAPI_READY\n", stderr);
    std::fflush(stderr);
    HANDLE hOut = GetStdHandle(STD_OUTPUT_HANDLE);
    std::vector<uint8_t> silenceBuf;
    while (WaitForSingleObject(hStop, 10) == WAIT_TIMEOUT) {
      UINT32 packetFrames = 0;
      hr = captureClient->GetNextPacketSize(&packetFrames);
      if (FAILED(hr)) {
        if (hr == AUDCLNT_E_DEVICE_INVALIDATED) std::fputs("DEVICE_INVALIDATED\n", stderr);
        break;
      }
      while (packetFrames > 0) {
        BYTE* data = nullptr;
        UINT32 numFrames = 0;
        DWORD flags = 0;
        hr = captureClient->GetBuffer(&data, &numFrames, &flags, nullptr, nullptr);
        if (FAILED(hr)) break;
        if (numFrames > 0) {
          size_t byteCount = static_cast<size_t>(numFrames) * wfx.nBlockAlign;
          const uint8_t* ptr = data;
          if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0 || data == nullptr) {
            if (silenceBuf.size() < byteCount) silenceBuf.assign(byteCount, 0);
            ptr = silenceBuf.data();
          }
          DWORD written = 0;
          if (!WriteFile(hOut, ptr, static_cast<DWORD>(byteCount), &written, nullptr) || written != byteCount) {
            captureClient->ReleaseBuffer(numFrames);
            SetEvent(hStop);
            break;
          }
        }
        captureClient->ReleaseBuffer(numFrames);
        if (FAILED(captureClient->GetNextPacketSize(&packetFrames))) break;
      }
    }
    audioClient->Stop();
  }

  if (captureClient) captureClient->Release();
  audioClient->Release();
  handler->Release();
  stopWatchThread(hStop, hWatch);
  CloseHandle(hReady);
  CloseHandle(hStop);
  CoUninitialize();
  return exitCode;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc == 2 && std::wcscmp(argv[1], L"--list-windows") == 0) {
    return listWindows();
  }
  if (argc == 3 && std::wcscmp(argv[1], L"--pid") == 0) {
    wchar_t* end = nullptr;
    unsigned long pid = std::wcstoul(argv[2], &end, 10);
    if (end == argv[2] || *end != L'\0' || pid == 0) {
      std::fputs("INVALID_PID\n", stderr);
      return 1;
    }
    return streamProcessLoopback(static_cast<DWORD>(pid));
  }
  std::fputs("Usage: ludy-wasapi-loopback --list-windows | --pid <pid>\n", stderr);
  return 1;
}
