# Use this curl to connect to websocket
```
curl --include --no-buffer --header "Connection: Upgrade" --header "Upgrade: websocket" --header "Host: localhost:8000" --header "Origin: http://localhost:8000" --header "Sec-WebSocket-Key: SGVsbG8sIHdvcmxkIQ==" --header "Sec-WebSocket-Version: 13" http://127.0.0.1:8000/ws/ce025d1563054d128f2aaa0d1767
426b
```
Change the link appropriately