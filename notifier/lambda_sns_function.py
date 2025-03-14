import os
import json
import urllib.parse
import http.client

WEBHOOK = os.environ.get('WEBHOOK')

if WEBHOOK is None:
    raise ValueError("Missing environment variables")

def notifyDiscordWebhook(event, context):

    url = urllib.parse.urlparse(WEBHOOK)
    conn = http.client.HTTPSConnection(url.netloc)

    headers = { 'Content-Type': 'application/json' }
    # Extract the message from the SNS event
    message = event['Records'][0]['Sns']['Message']

    # Prepare the data to send to Discord
    data = {
        "content": message  # You can add more fields if you want to customize the Discord message
    }

    conn.request("POST", url.path + "?" + url.query, body=json.dumps(data), headers=headers)
    res = conn.getresponse()

    # Check the response
    if res.status != 204:
        raise ValueError(f'Request to Discord returned an error {res.status}, the response is:\n{res.read().decode()}')