#!/bin/bash

BASE_URL="http://localhost:3000/api"

echo "1. Login User 1..."
RESPONSE=$(curl -s -X POST $BASE_URL/auth/login -H "Content-Type: application/json" -d '{"email":"api1@test.com","password":"password"}')
TOKEN1=$(echo $RESPONSE | grep -o '"token":"[^"]*' | cut -d'"' -f4)
ID1=$(echo $RESPONSE | grep -o '"id":[0-9]*' | head -n 1 | cut -d':' -f2)

# 1. Reels
echo -e "\n2. User 1 Creates Reel..."
touch test_reel.mp4
RESPONSE=$(curl -s -X POST $BASE_URL/posts -H "Authorization: Bearer $TOKEN1" -F "media=@test_reel.mp4;type=video/mp4" -F "caption=My First Reel" -F "is_reel=true")
echo "Reel Creation: $RESPONSE"
rm test_reel.mp4

echo -e "\n3. List Reels..."
curl -s -X GET $BASE_URL/reels -H "Authorization: Bearer $TOKEN1"

# 2. Live Streaming
echo -e "\n4. User 1 Starts Live Stream..."
RESPONSE=$(curl -s -X POST $BASE_URL/live/start -H "Authorization: Bearer $TOKEN1" -H "Content-Type: application/json")
STREAM_ID=$(echo $RESPONSE | grep -o '"id":[0-9]*' | head -n 1 | cut -d':' -f2)
echo "Stream Started ID: $STREAM_ID"

echo -e "\n5. List Active Streams..."
curl -s -X GET $BASE_URL/live -H "Authorization: Bearer $TOKEN1"

echo -e "\n6. Send Chat Message..."
curl -s -X POST $BASE_URL/live/$STREAM_ID/message -H "Authorization: Bearer $TOKEN1" -H "Content-Type: application/json" -d '{"content":"Hello Live World"}'

echo -e "\n7. Get Chat Messages..."
curl -s -X GET $BASE_URL/live/$STREAM_ID/messages -H "Authorization: Bearer $TOKEN1"

echo -e "\n8. End Stream..."
curl -s -X POST $BASE_URL/live/end -H "Authorization: Bearer $TOKEN1" -H "Content-Type: application/json"

echo -e "\n\nDone."
