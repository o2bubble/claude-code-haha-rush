using System;
using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace ClaudeCodeVS.Services
{
    /// <summary>
    /// WebSocket client connecting to the Bun backend.
    /// Handles sending/receiving JSON messages with queuing and reconnect.
    /// Ported from the WebSocket logic in extensions/vscode/src/processManager.ts.
    /// </summary>
    public class WebSocketClient : IDisposable
    {
        private const int MaxQueueSize = 50;

        private ClientWebSocket _ws;
        private string _url;
        private CancellationTokenSource _receiveCts;
        private readonly ConcurrentQueue<string> _outgoingQueue = new ConcurrentQueue<string>();
        private bool _started;

        public bool IsConnected => _ws?.State == WebSocketState.Open;

        public event EventHandler<string> MessageReceived;
        public event EventHandler<string> StatusChanged;
        public event EventHandler<string> LogReceived;

        public WebSocketClient(string url)
        {
            _url = url;
        }

        public async Task ConnectAsync()
        {
            _started = true;
            await ConnectAsync(_url);
        }

        public async Task ReconnectAsync(string newUrl)
        {
            await DisconnectAsync(WebSocketCloseStatus.NormalClosure);
            _url = newUrl;
            await Task.Delay(1000);
            await ConnectAsync(_url);
        }

        public void Send(string json)
        {
            if (_ws?.State == WebSocketState.Open)
            {
                _ = SendMessageAsync(json);
            }
            else
            {
                // Queue up to 50 messages while disconnected
                if (_outgoingQueue.Count < MaxQueueSize)
                {
                    _outgoingQueue.Enqueue(json);
                }
                else
                {
                    LogReceived?.Invoke(this, "WebSocket outgoing queue full, dropping message");
                }
            }
        }

        public async Task DisconnectAsync(WebSocketCloseStatus closeStatus = WebSocketCloseStatus.NormalClosure)
        {
            _started = false;
            _receiveCts?.Cancel();

            if (_ws?.State == WebSocketState.Open)
            {
                try
                {
                    await _ws.CloseAsync(closeStatus, "Closing", CancellationToken.None);
                }
                catch { /* ignore close errors */ }
            }

            _ws?.Dispose();
            _ws = null;
            StatusChanged?.Invoke(this, "disconnected");
        }

        // ── Internal ──────────────────────────────────────────────────────────

        private async Task ConnectAsync(string url)
        {
            try
            {
                Services.Logger.Info($"WebSocket connecting to {url}...");
                _ws = new ClientWebSocket();
                await _ws.ConnectAsync(new Uri(url), CancellationToken.None);
                Services.Logger.Info("WebSocket connected OK");

                StatusChanged?.Invoke(this, "connected");

                // Flush queued messages
                while (_outgoingQueue.TryDequeue(out var msg))
                {
                    await SendMessageAsync(msg);
                }

                // Start receive loop
                _receiveCts = new CancellationTokenSource();
                _ = ReceiveLoopAsync(_receiveCts.Token);

                Services.Logger.Info("WebSocket receive loop started, firing ready");
                StatusChanged?.Invoke(this, "ready");
            }
            catch (Exception ex)
            {
                Services.Logger.Error($"WebSocket connect failed: {ex.Message}", ex);
                LogReceived?.Invoke(this, $"WebSocket connect failed: {ex.Message}");
                StatusChanged?.Invoke(this, "disconnected");
            }
        }

        private async Task SendMessageAsync(string json)
        {
            if (_ws?.State != WebSocketState.Open) return;

            try
            {
                var bytes = Encoding.UTF8.GetBytes(json);
                await _ws.SendAsync(
                    new ArraySegment<byte>(bytes),
                    WebSocketMessageType.Text,
                    endOfMessage: true,
                    CancellationToken.None);
            }
            catch (Exception ex)
            {
                LogReceived?.Invoke(this, $"WebSocket send error: {ex.Message}");
            }
        }

        private async Task ReceiveLoopAsync(CancellationToken ct)
        {
            var buffer = new byte[65536];

            try
            {
                while (_ws?.State == WebSocketState.Open && !ct.IsCancellationRequested)
                {
                    var result = await _ws.ReceiveAsync(new ArraySegment<byte>(buffer), ct);

                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        await _ws.CloseAsync(
                            WebSocketCloseStatus.NormalClosure,
                            "Server closed",
                            CancellationToken.None);
                        StatusChanged?.Invoke(this, "disconnected");
                        break;
                    }

                    if (result.MessageType == WebSocketMessageType.Text)
                    {
                        var json = Encoding.UTF8.GetString(buffer, 0, result.Count);

                        // Handle multi-frame messages
                        if (!result.EndOfMessage)
                        {
                            var sb = new StringBuilder(json);
                            while (!result.EndOfMessage)
                            {
                                result = await _ws.ReceiveAsync(new ArraySegment<byte>(buffer), ct);
                                sb.Append(Encoding.UTF8.GetString(buffer, 0, result.Count));
                            }
                            json = sb.ToString();
                        }

                        MessageReceived?.Invoke(this, json);
                    }
                }
            }
            catch (OperationCanceledException)
            {
                // Normal shutdown
            }
            catch (WebSocketException ex)
            {
                LogReceived?.Invoke(this, $"WebSocket receive error: {ex.Message}");
                StatusChanged?.Invoke(this, "disconnected");

                // Auto-reconnect after 1 second (from processManager.ts onclose logic)
                if (_started && _ws?.CloseStatus != WebSocketCloseStatus.NormalClosure)
                {
                    await Task.Delay(1000, CancellationToken.None);
                    if (_started)
                    {
                        await ConnectAsync(_url);
                    }
                }
            }
            catch (Exception ex)
            {
                LogReceived?.Invoke(this, $"WebSocket error: {ex.Message}");
            }
        }

        public void Dispose()
        {
            _started = false;
            _receiveCts?.Cancel();
            _ws?.Dispose();
            _ws = null;
        }
    }
}
