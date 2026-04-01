# Issue: TextBee SMS Gateway Integration

## Summary

Integrate [TextBee](https://github.com/vernu/textbee) as an SMS gateway for Rivr groups. Groups should be able to set up an old Android phone as a self-hosted SMS gateway, enabling SMS-based communication for group members who don't have the app.

## Context

TextBee is an open-source SMS gateway that turns any Android phone into an SMS API server. It exposes a REST API for sending/receiving SMS messages. This fits the Rivr model of community infrastructure running on commodity hardware.

## Requirements

- Groups can register a TextBee gateway instance in their group settings
- Gateway config: TextBee API URL + API key, stored in group metadata
- Outbound: group announcements, event invites, and live invite notifications can be sent via SMS to members who opt in
- Inbound: SMS replies from members can be routed back into group discussions or event RSVPs
- Setup UX should be dead simple: "plug in old Android, install TextBee app, enter the URL here"
- Per-group configuration — each group can have its own gateway device

## Technical Notes

- TextBee repo: https://github.com/vernu/textbee
- TextBee exposes REST API for send/receive
- Store gateway config in group agent metadata: `{ textbeeUrl, textbeeApiKey }`
- New server action: `sendGroupSms(groupId, message, recipientIds)`
- New webhook handler: `POST /api/groups/[id]/sms-inbound` for TextBee webhook delivery
- Member phone numbers stored in agent metadata (opt-in)
- Rate limiting per group to prevent abuse

## Where This Fits

- Group settings UI: new "SMS Gateway" section
- Notification system: SMS as additional delivery channel alongside in-app + email
- Event invites: SMS delivery option for live invite posts
- RSVP: inbound SMS parsing for "yes"/"no" RSVP responses

## Priority

Medium — valuable for communities with members who don't use the app regularly.
