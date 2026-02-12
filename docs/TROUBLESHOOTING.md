# Feishu Bot Troubleshooting Guide

## Current Status
✅ Bot process is running (PID: 4175865)
✅ WebSocket connection established
✅ Bot info fetched: `ou_14563f35d1d76cd55f87164ba071f60b`
❌ No messages being received

## Checklist to Fix "No Response" Issue

### 1. Is the Bot Added to the Group?
**Action**: In Feishu, check if the bot is a member of the group.

**How to add**:
- Open the group chat
- Click group settings (top right)
- Click "Add Members" or "添加成员"
- Search for your bot name
- Add the bot to the group

**Verify**: You should see the bot listed in the group members.

---

### 2. Check Feishu App Configuration

Go to [Feishu Open Platform](https://open.feishu.cn/) → Your App

#### A. Bot Capability
- Go to **应用能力** (App Capabilities)
- Verify **机器人** (Bot) is enabled
- If not, add it and publish a new version

#### B. Event Subscription
- Go to **事件与回调** (Events & Callbacks) → **事件配置** (Event Configuration)
- **订阅方式** (Subscription Mode) must be: **使用长连接接收事件** (Use persistent connection)
- **订阅事件** (Subscribed Events) must include: `im.message.receive_v1`

**If not configured**:
1. Select "使用长连接接收事件"
2. Add event: `im.message.receive_v1` (接收消息)
3. Save and publish new version

#### C. Permissions
- Go to **权限管理** (Permissions)
- Verify these permissions are enabled:
  - ✅ `im:message` - 获取与发送单聊、群组消息
  - ✅ `im:message:readonly` - 读取消息
  - ✅ `im:resource` - 读取与上传图片或文件 (for file transfer)

**If missing**: Enable them and publish new version

#### D. App Availability
- Go to **版本管理与发布** (Version Management & Release)
- Verify the app is **已发布** (Published) and **审核通过** (Approved)
- Verify the app is available to your organization/users

---

### 3. Test in Different Scenarios

#### Test 1: Direct Message (DM)
1. Open a direct message with the bot
2. Send: `hello`
3. Expected: Bot should respond (no @mention needed in DM)

#### Test 2: Group Chat with @mention
1. In the group, type: `@BotName hello`
2. Make sure you actually @mention the bot (should show as a blue tag)
3. Expected: Bot should respond

#### Test 3: Check Logs
While testing, watch the logs in real-time:
```bash
tail -f /tmp/claude-1001/-home-admin-feishu-claudecode/tasks/bb5da51.output
```

Look for:
- `Received message` - Message was received
- `Ignoring group message without @mention` - You didn't @mention the bot
- `Ignoring group message that does not @mention the bot` - Wrong bot was mentioned
- `Unauthorized message` - User/chat not authorized

---

### 4. Enable Debug Logging

To see more detailed logs, edit `.env`:
```bash
LOG_LEVEL=debug
```

Then restart the bot:
```bash
# Kill current process
pkill -f "tsx src/index.ts"

# Start with debug logging
npm run dev
```

Debug logs will show:
- All received events
- Why messages are being ignored
- Authorization checks
- @mention detection

---

### 5. Common Issues & Solutions

#### Issue: "Ignoring group message without @mention"
**Solution**: You must @mention the bot in group chats. Type `@` and select the bot from the dropdown.

#### Issue: "Unauthorized message"
**Solution**:
- Check if `AUTHORIZED_USER_IDS` or `AUTHORIZED_CHAT_IDS` is set in `.env`
- If set, add your user ID or chat ID to the list
- Or remove the restriction (leave empty to allow all)

#### Issue: No logs at all when sending messages
**Solution**:
- Bot is not receiving events from Feishu
- Check event subscription configuration (step 2B above)
- Verify bot is added to the group
- Restart the bot after making changes

#### Issue: "Bot has NO availability to this user"
**Solution**:
- Go to Feishu Open Platform → Your App
- Go to **可用性** (Availability)
- Make sure the app is available to your organization/users
- Publish new version if needed

---

### 6. Quick Diagnostic Commands

```bash
# Check if bot is running
ps aux | grep "tsx src/index.ts"

# View live logs
tail -f /tmp/claude-1001/-home-admin-feishu-claudecode/tasks/bb5da51.output

# Restart bot
pkill -f "tsx src/index.ts" && npm run dev

# Check .env configuration
cat .env
```

---

### 7. Get Your User ID

To check authorization, you need your user open_id:

1. Send `/status` command to the bot (in DM or group)
2. The bot will show your `open_id`
3. If you need to restrict access, add this ID to `AUTHORIZED_USER_IDS` in `.env`

---

## Most Likely Issues

Based on "no response at all", the most likely causes are:

1. **Bot not added to the group** (90% of cases)
   - Solution: Add bot to group members

2. **Event subscription not configured correctly** (5% of cases)
   - Solution: Check step 2B above

3. **App not published/approved** (3% of cases)
   - Solution: Publish and get approval

4. **Not actually @mentioning the bot** (2% of cases)
   - Solution: Type `@` and select bot from dropdown (should show as blue tag)

---

## Next Steps

1. ✅ Verify bot is added to the group
2. ✅ Check event subscription configuration
3. ✅ Try sending a DM to the bot first (easier to test)
4. ✅ Watch logs while testing: `tail -f /tmp/claude-1001/-home-admin-feishu-claudecode/tasks/bb5da51.output`
5. ✅ Enable debug logging if still not working

---

## Contact Info

Bot Open ID: `ou_14563f35d1d76cd55f87164ba071f60b`
App ID: `cli_a90059cd097a1cef`

If you see this ID in the group members list, the bot is properly added.
