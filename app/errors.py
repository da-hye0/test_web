class UserError(Exception):
    """사용자에게 그대로 보여줄 메시지가 있는 오류"""

    def __init__(self, message: str, user_message: str | None = None, status: int = 502):
        super().__init__(message)
        self.user_message = user_message
        self.status = status
