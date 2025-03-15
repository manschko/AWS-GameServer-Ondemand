#!/bin/bash

## Required Environment Variables

[ -n "$CLUSTER" ] || { echo "CLUSTER env variable must be set to the name of the ECS cluster" ; exit 1; }
[ -n "$SERVICE" ] || { echo "SERVICE env variable must be set to the name of the service in the $CLUSTER cluster" ; exit 1; }
[ -n "$SERVERNAME" ] || { echo "SERVERNAME env variable must be set to the full A record in Route53 we are updating" ; exit 1; }
[ -n "$DNSZONE" ] || { echo "DNSZONE env variable must be set to the Route53 Hosted Zone ID" ; exit 1; }
[ -n "$STARTUPMIN" ] || { echo "STARTUPMIN env variable not set, defaulting to a 10 minute startup wait" ; STARTUPMIN=10; }
[ -n "$SHUTDOWNMIN" ] || { echo "SHUTDOWNMIN env variable not set, defaulting to a 20 minute shutdown wait" ; SHUTDOWNMIN=20; }
[ -n "$GAME_TCP_PORTS" ] || { echo "GAME_TCP_PORTS env variable not set, no TCP ports will be monitored" ; GAME_TCP_PORTS=""; }
[ -n "$GAME_UDP_PORTS" ] || { echo "GAME_UDP_PORTS env variable not set, no UDP ports will be monitored" ; GAME_UDP_PORTS=""; }
[ -n "$CUSTOM_CHECK_COMMAND" ] || { CUSTOM_CHECK_COMMAND=""; }


function send_notification ()
{
  [ "$1" = "startup" ] && MESSAGETEXT="${SERVICE} is online at ${SERVERNAME}"
  [ "$1" = "shutdown" ] && MESSAGETEXT="Shutting down ${SERVICE} at ${SERVERNAME}"
  [ "$1" = "attempting" ] && MESSAGETEXT="Attempting to start ${SERVICE} at ${SERVERNAME}"

  ## Twilio Option
  [ -n "$TWILIOFROM" ] && [ -n "$TWILIOTO" ] && [ -n "$TWILIOAID" ] && [ -n "$TWILIOAUTH" ] && \
  echo "Twilio information set, sending $1 message" && \
  curl --silent -XPOST -d "Body=$MESSAGETEXT" -d "From=$TWILIOFROM" -d "To=$TWILIOTO" "https://api.twilio.com/2010-04-01/Accounts/$TWILIOAID/Messages" -u "$TWILIOAID:$TWILIOAUTH"

  ## SNS Option
  [ -n "$SNSTOPIC" ] && \
  echo "SNS topic set, sending $1 message" && \
  aws sns publish --topic-arn "$SNSTOPIC" --message "$MESSAGETEXT"

   ## Discord Webhook Option
  [ -n "$DISCORD_WEBHOOK" ] && \
  echo "Discord webhook set, sending $1 message" && \
  curl -H "Content-Type: application/json" -X POST -d "{\"content\":\"$MESSAGETEXT\"}" $DISCORD_WEBHOOK
}

function zero_service ()
{
  send_notification shutdown
  echo Setting desired task count to zero.
  aws ecs update-service --cluster $CLUSTER --service $SERVICE --desired-count 0
  exit 0
}

function sigterm ()
{
  ## upon SIGTERM set the service desired count to zero
  echo "Received SIGTERM, terminating task..."
  zero_service
}
trap sigterm SIGTERM

# Send notification that we're attempting to start the server
send_notification attempting

## get task id from the Fargate metadata
TASK=$(curl -s ${ECS_CONTAINER_METADATA_URI_V4}/task | jq -r '.TaskARN' | awk -F/ '{ print $NF }')
echo I believe our task id is $TASK

## get eni from from ECS
ENI=$(aws ecs describe-tasks --cluster $CLUSTER --tasks $TASK --query "tasks[0].attachments[0].details[?name=='networkInterfaceId'].value | [0]" --output text)
echo I believe our eni is $ENI

## get public ip address from EC2
PUBLICIP=$(aws ec2 describe-network-interfaces --network-interface-ids $ENI --query 'NetworkInterfaces[0].Association.PublicIp' --output text)
echo "I believe our public IP address is $PUBLICIP"

## update public dns record
echo "Updating DNS record for $SERVERNAME to $PUBLICIP"
## prepare json file
cat << EOF >> dns-update.json
{
  "Comment": "Fargate Public IP change for ${SERVERNAME}",
  "Changes": [
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "$SERVERNAME",
        "Type": "A",
        "TTL": 30,
        "ResourceRecords": [
          {
            "Value": "$PUBLICIP"
          }
        ]
      }
    }
  ]
}
EOF
aws route53 change-resource-record-sets --hosted-zone-id $DNSZONE --change-batch file://dns-update.json

## Wait for server to start up by checking for listening ports
echo "Waiting for $SERVERNAME to start listening on ports..."
echo "If we are stuck here, the game server container probably failed to start. Waiting 10 minutes just in case..."

COUNTER=0
SERVER_STARTED=0
while [ $SERVER_STARTED -lt 1 ] && [ $COUNTER -lt 600 ]
do
  # Check TCP ports if specified
  if [ -n "$GAME_TCP_PORTS" ]; then
    for PORT in $(echo $GAME_TCP_PORTS | tr ',' ' '); do
      netstat -atn | grep ":$PORT" | grep LISTEN && SERVER_STARTED=1 && echo "Server detected listening on TCP port $PORT" && break
    done
  fi
  
  # Check UDP ports if specified and server not yet detected
  if [ $SERVER_STARTED -eq 0 ] && [ -n "$GAME_UDP_PORTS" ]; then
    for PORT in $(echo $GAME_UDP_PORTS | tr ',' ' '); do
      netstat -aun | grep ":$PORT" && SERVER_STARTED=1 && echo "Server detected listening on UDP port $PORT" && break
    done
  fi
  
  # Run custom check command if provided and server not yet detected
  if [ $SERVER_STARTED -eq 0 ] && [ -n "$CUSTOM_CHECK_COMMAND" ]; then
    eval "$CUSTOM_CHECK_COMMAND" && SERVER_STARTED=1 && echo "Server detected using custom check command"
  fi
  
  # Increment counter and sleep if server not detected
  if [ $SERVER_STARTED -eq 0 ]; then
    sleep 1
    COUNTER=$(($COUNTER + 1))
    if [ $(($COUNTER % 60)) -eq 0 ]; then
      echo "Still waiting for server to start... ${COUNTER}/600 seconds elapsed"
    fi
  fi
done

if [ $SERVER_STARTED -eq 0 ]; then
  echo "10 minutes elapsed without server listening, terminating."
  zero_service
fi

echo "$SERVERNAME is now ready!"
send_notification startup

# Function to check for active connections
check_connections() {
  CONNECTIONS=0
  
  # Check TCP connections if ports specified
  if [ -n "$GAME_TCP_PORTS" ]; then
    for PORT in $(echo $GAME_TCP_PORTS | tr ',' ' '); do
      TCP_CONN=$(netstat -atn | grep ":$PORT" | grep ESTABLISHED | wc -l)
      CONNECTIONS=$(($CONNECTIONS + $TCP_CONN))
    done
  fi
  
  # Check UDP connections if ports specified
  if [ -n "$GAME_UDP_PORTS" ]; then
    for PORT in $(echo $GAME_UDP_PORTS | tr ',' ' '); do
      # For UDP, we count any sockets in the TIME_WAIT or ESTABLISHED state as active connections
      UDP_CONN=$(netstat -aun | grep ":$PORT" | egrep -v "LISTEN|TIME_WAIT" | wc -l)
      CONNECTIONS=$(($CONNECTIONS + $UDP_CONN))
    done
  fi
  
  
  # Run custom connection check if provided
  if [ -n "$CUSTOM_CHECK_COMMAND" ]; then
    CUSTOM_CONN=$(eval "$CUSTOM_CHECK_COMMAND")
    [ -n "$CUSTOM_CONN" ] && CONNECTIONS=$(($CONNECTIONS + $CUSTOM_CONN))
  fi
  
  echo $CONNECTIONS
}

echo "Checking every 1 minute for active connections to $SERVER_NAME, up to $STARTUPMIN minutes..."
COUNTER=0
CONNECTED=0
while [ $CONNECTED -lt 1 ]
do
  echo "Waiting for connection, minute $COUNTER out of $STARTUPMIN..."
  CONNECTIONS=$(check_connections)
  [ -n "$CONNECTIONS" ] || CONNECTIONS=0
  CONNECTED=$(($CONNECTED + $CONNECTIONS))
  COUNTER=$(($COUNTER + 1))
  if [ $CONNECTED -gt 0 ]; then
    # At least one active connection detected, break out of loop
    echo "Detected $CONNECTIONS active connection(s)!"
    break
  fi
  if [ $COUNTER -gt $STARTUPMIN ]; then
    # No one has connected in at least these many minutes
    echo "$STARTUPMIN minutes exceeded without a connection, terminating."
    zero_service
  fi
  # Only doing short sleeps so that we can catch a SIGTERM if needed
  for i in $(seq 1 59); do sleep 1; done
done

echo "We believe a connection has been made, switching to shutdown watcher."
COUNTER=0
while [ $COUNTER -le $SHUTDOWNMIN ]
do
  CONNECTIONS=$(check_connections)
  [ -n "$CONNECTIONS" ] || CONNECTIONS=0
  if [ $CONNECTIONS -lt 1 ]; then
    echo "No active connections detected, $COUNTER out of $SHUTDOWNMIN minutes..."
    COUNTER=$(($COUNTER + 1))
  else
    [ $COUNTER -gt 0 ] && echo "New connections active ($CONNECTIONS), zeroing counter."
    COUNTER=0
  fi
  for i in $(seq 1 59); do sleep 1; done
done

echo "$SHUTDOWNMIN minutes elapsed without a connection, terminating."
zero_service