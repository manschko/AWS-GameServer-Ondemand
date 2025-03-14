# version 1.2.0
# docker pull doctorray/minecraft-ecsfargate-watchdog

FROM amazon/aws-cli

RUN yum install -y net-tools jq nmap-ncat && \
    yum clean all

COPY ./watchdog.sh .

#ENTRYPOINT ["tail", "-f", "/dev/null"]
ENTRYPOINT ["./watchdog.sh"]
