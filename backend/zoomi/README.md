# Use this curl to connect to websocket
```
curl --include --no-buffer --header "Connection: Upgrade" --header "Upgrade: websocket" --header "Host: localhost:8000" --header "Origin: http://localhost:8000" --header "Sec-WebSocket-Key: SGVsbG8sIHdvcmxkIQ==" --header "Sec-WebSocket-Version: 13" http://127.0.0.1:8000/ws/d06df5f398f142c5b9275f8d72f5789c
```
Change the link appropriately