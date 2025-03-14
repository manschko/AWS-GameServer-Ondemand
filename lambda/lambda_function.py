import os
import boto3
import json
import urllib.parse
import http.client

DEFAULT_REGION = 'us-west-2'
DEFAULT_CLUSTER = 'minecraft'
DEFAULT_SERVICE = 'minecraft-server'

REGION = os.environ.get('REGION', DEFAULT_REGION)
CLUSTER = os.environ.get('CLUSTER', DEFAULT_CLUSTER)
SERVICE = os.environ.get('SERVICE', DEFAULT_SERVICE)
WEBHOOK = os.environ.get('WEBHOOK')

if REGION is None or CLUSTER is None or SERVICE is None:
    raise ValueError("Missing environment variables")


def lambda_handler(event, context):
    """Updates the desired count for a service."""

    ecs = boto3.client('ecs', region_name=REGION)
    response = ecs.describe_services(
        cluster=CLUSTER,
        services=[SERVICE],
    )

    desired = response["services"][0]["desiredCount"]

    if desired == 0:
        ecs.update_service(
            cluster=CLUSTER,
            service=SERVICE,
            desiredCount=1,
        )
        print("Updated desiredCount to 1")
    else:
        print("desiredCount already at 1")


def notifyDiscordWebhook():
    url = urllib.parse.urlparse(WEBHOOK)
    conn = http.client.HTTPSConnection(url.netloc)

    headers = { 'Content-Type': 'application/json' }
    # Extract the message from the SNS event
    message = "attempting to Start Minecraft"

    # Prepare the data to send to Discord
    data = {
        "content": message  # You can add more fields if you want to customize the Discord message
    }

    conn.request("POST", url.path + "?" + url.query, body=json.dumps(data), headers=headers)
    res = conn.getresponse()

    # Check the response
    if res.status != 204:
        raise ValueError(f'Request to Discord returned an error {res.status}, the response is:\n{res.read().decode()}')
